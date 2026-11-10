using System.Collections.Immutable;
using System.Text.Json.Nodes;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Features.Views;
using Nix.Integration.Tests.Harness;
using Nix.Messaging;

namespace Nix.Integration.Tests.Persistence;

/// <summary>
/// Writing property values, declaring schemas, and configuring views - through the use cases a
/// request reaches.
/// </summary>
/// <remarks>
/// The cascade has its own property test. What is left is everything around it: what a write
/// refuses, what it preserves, and what happens to stored values when the schema beneath them
/// changes. That last one is the promise ADR-0007 §4 makes, and it is the one most likely to be
/// broken by somebody making validation stricter for good reasons.
/// </remarks>
[Collection(PostgresCollectionDefinition.Name)]
public sealed class PropertyWriteTests : IAsyncLifetime
{
    private readonly NixPostgresFixture _fixture;

    public PropertyWriteTests(NixPostgresFixture fixture) => _fixture = fixture;

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    private static WorkspaceId Workspace => WorkspaceId.From(M0SchemaSeed.Alpha.WorkspaceId);

    public async ValueTask InitializeAsync()
    {
        await _fixture.ResetAsync();
        await M0SchemaSeed.SeedBothTenantsAsync(_fixture);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Long_text_round_trips_newlines_at_the_limit_and_refuses_an_extra_character()
    {
        ItemId noteId;
        var text = "first\n" + new string('x', 7_994);
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Long text", null);
            var dispatcher = work.Resolve<NixDispatcher>();
            var declared = await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(folder.Id, new PropertySchema
                {
                    Inherit = true,
                    Properties = [new PropertyDefinition("details", "Details", PropertyType.LongText, [], false)],
                }), Cancellation);
            Assert.True(declared.IsSuccess);
            noteId = (await NewItemAsync(work, "Entry", folder.Id)).Id;
            var written = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(noteId, new JsonObject { ["details"] = text }.ToJsonString()), Cancellation);
            Assert.True(written.IsSuccess);
            var refused = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(noteId, new JsonObject { ["details"] = text + "x" }.ToJsonString()), Cancellation);
            Assert.True(refused.IsFailure);
            Assert.Equal("properties.invalid", refused.Error.Code);
            await work.CommitAsync(Cancellation);
        }

        var readWork = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (readWork.ConfigureAwait(false))
        {
            var read = await readWork.Resolve<NixDispatcher>().QueryAsync<GetItem, Result<Item>>(
                new GetItem(noteId), Cancellation);
            Assert.True(read.IsSuccess);
            Assert.NotNull(read.Value.Properties);
            Assert.Equal(text, JsonNode.Parse(read.Value.Properties)!["details"]!.GetValue<string>());
        }
    }

    [Fact]
    public async Task A_value_that_fits_the_schema_is_stored()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);

            var dispatcher = work.Resolve<NixDispatcher>();
            var written = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"status":"Doing"}"""),
                Cancellation);

            Assert.True(written.IsSuccess, written.IsSuccess ? "" : written.Error.Message);
            Assert.Contains("Doing", written.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_value_the_select_does_not_offer_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);

            var dispatcher = work.Resolve<NixDispatcher>();
            var written = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"status":"Elsewhere"}"""),
                Cancellation);

            Assert.True(written.IsFailure);
            Assert.Equal("properties.invalid", written.Error.Code);
        }
    }

    [Fact]
    public async Task A_write_merges_rather_than_replacing()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);
            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"status":"Todo"}"""),
                Cancellation);
            var second = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"note":"a remark"}"""),
                Cancellation);

            Assert.True(second.IsSuccess, second.IsSuccess ? "" : second.Error.Message);

            // A board dragging a card sends one property. Replacing the bag would drop every other
            // property the item carries - starting with its title, which lives in there too.
            Assert.Contains("Todo", second.Value.Properties, StringComparison.Ordinal);
            Assert.Contains("a remark", second.Value.Properties, StringComparison.Ordinal);
            Assert.Equal("Note", ItemProperties.ReadTitle(second.Value.Properties));
        }
    }

    [Fact]
    public async Task An_explicit_null_clears_a_property()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);
            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"status":"Todo"}"""),
                Cancellation);
            var cleared = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"status":null}"""),
                Cancellation);

            Assert.True(cleared.IsSuccess, cleared.IsSuccess ? "" : cleared.Error.Message);
            Assert.DoesNotContain("Todo", cleared.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task An_item_can_be_created_with_its_properties_already_set()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var dispatcher = work.Resolve<NixDispatcher>();

            // The gesture this exists for: a card made straight into a column, rather than made at
            // the root and then dragged and then edited.
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(
                    Workspace,
                    "note",
                    "Search ranking",
                    folder.Id,
                    new JsonObject { ["status"] = "Doing" }),
                Cancellation);

            Assert.True(created.IsSuccess);
            Assert.Contains("Doing", created.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_property_supplied_on_creation_faces_the_same_schema_a_later_write_would()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var dispatcher = work.Resolve<NixDispatcher>();

            // Otherwise the way to store a value the schema refuses would be to supply it a moment
            // earlier, which is not a rule so much as a delay.
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(
                    Workspace,
                    "note",
                    "Search ranking",
                    folder.Id,
                    new JsonObject { ["status"] = "Nonsense" }),
                Cancellation);

            Assert.True(created.IsFailure);
            Assert.Equal("properties.invalid", created.Error.Code);
        }
    }

    [Fact]
    public async Task A_required_property_does_not_have_to_be_supplied_at_creation()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    folder.Id,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties = [new PropertyDefinition("owner", "Owner", PropertyType.Text, [], true)],
                    }),
                Cancellation);

            // A required property is a statement about a finished item, not about a first
            // keystroke. Enforced here, nothing could ever be created inside this folder - the
            // ordinary act of making a note and then filling it in would be refused at step one.
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(Workspace, "note", "Untitled note", folder.Id, null),
                Cancellation);

            Assert.True(created.IsSuccess);
        }
    }

    [Fact]
    public async Task A_title_in_the_property_bag_does_not_override_the_one_that_was_named()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var dispatcher = work.Resolve<NixDispatcher>();

            // Every listing reads the promoted title. Two disagreeing spellings of it would show
            // one name in the tree and another on the item.
            var created = await dispatcher.SendAsync<CreateItem, Item>(
                new CreateItem(
                    Workspace,
                    "note",
                    "The real one",
                    null,
                    new JsonObject { ["title"] = "The impostor" }),
                Cancellation);

            Assert.True(created.IsSuccess);
            Assert.Equal("The real one", ItemProperties.ReadTitle(created.Value.Properties));
        }
    }

    [Fact]
    public async Task A_required_property_declared_later_does_not_lock_the_items_that_already_exist()
    {
        // The whole reason the write path stopped asking for a complete bag. This used to fail:
        // the note predates the requirement, has no owner, and a write touching something else
        // was refused over it. Declaring a property required would have write-locked every item
        // beneath the folder, and the only way out was a write supplying every missing required
        // value at once - which no screen in the product offers.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            var dispatcher = work.Resolve<NixDispatcher>();

            var note = await NewItemAsync(work, "Note", folder.Id);

            // The requirement arrives after the note, which is the ordinary order: people author a
            // schema once there is something to describe.
            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    folder.Id,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties =
                        [
                            new PropertyDefinition("owner", "Owner", PropertyType.Text, [], true),
                            new PropertyDefinition("stage", "Stage", PropertyType.Text, [], false),
                        ],
                    }),
                Cancellation);

            var written = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"stage":"Drafting"}"""),
                Cancellation);

            Assert.True(written.IsSuccess);
            Assert.Contains("Drafting", written.Value.Properties, StringComparison.Ordinal);

            // And the required key it never mentioned is still absent. Asserted so that a future
            // "helpfully fill in the required value" would fail here rather than pass quietly.
            Assert.DoesNotContain("owner", written.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_write_that_clears_a_required_property_is_still_refused()
    {
        // The other half, and what keeps "required" meaning anything: you are not blocked by a
        // required value somebody else left empty, but you cannot empty one yourself.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    folder.Id,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties = [new PropertyDefinition("owner", "Owner", PropertyType.Text, [], true)],
                    }),
                Cancellation);

            var note = await NewItemAsync(work, "Note", folder.Id);

            var filled = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"owner":"Ada"}"""),
                Cancellation);
            Assert.True(filled.IsSuccess);

            var cleared = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"owner":null}"""),
                Cancellation);

            Assert.True(cleared.IsFailure);
            Assert.Equal("properties.invalid", cleared.Error.Code);
            Assert.Contains("Owner", cleared.Error.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_write_setting_a_required_property_to_a_value_that_does_not_fit_is_refused()
    {
        // Loosening which values are owed must not loosen how a supplied value is checked.
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    folder.Id,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties =
                        [
                            new PropertyDefinition(
                                "stage",
                                "Stage",
                                PropertyType.Select,
                                ["Drafting", "Shipped"],
                                true),
                        ],
                    }),
                Cancellation);

            var note = await NewItemAsync(work, "Note", folder.Id);

            var written = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"stage":"Abandoned"}"""),
                Cancellation);

            Assert.True(written.IsFailure);
            Assert.Equal("properties.invalid", written.Error.Code);

            // Named, not just coded: a refusal that does not say which property is at fault sends
            // the reader to look at all of them.
            Assert.Contains("Stage", written.Error.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Removing_a_property_from_a_schema_leaves_its_values_intact()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var note = await NewItemAsync(work, "Note", folder.Id);
            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"status":"Doing"}"""),
                Cancellation);

            // The schema is edited out from under the value.
            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(folder.Id, PropertySchema.Empty),
                Cancellation);

            // The value survives, and the next write to the item still succeeds. The alternative -
            // invalidating stored data because somebody edited a definition - would mean one schema
            // edit breaks the next write to every item beneath it, on data the writer never
            // touched. See ADR-0007 §4.
            var after = await dispatcher.SendAsync<SetItemProperties, Item>(
                new SetItemProperties(note.Id, """{"note":"still fine"}"""),
                Cancellation);

            Assert.True(after.IsSuccess, after.IsSuccess ? "" : after.Error.Message);
            Assert.Contains("Doing", after.Value.Properties, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_schema_cannot_redeclare_the_title()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();

            var declared = await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    folder.Id,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties = [new PropertyDefinition("title", "Name", PropertyType.Text, [], true)],
                    }),
                Cancellation);

            // The title is promoted to a first-class field and written by the rename path. A schema
            // redeclaring it would give one value two owners with different rules.
            Assert.True(declared.IsFailure);
            Assert.Equal("schema.invalid", declared.Error.Code);
        }
    }

    [Fact]
    public async Task A_select_with_no_options_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();

            var declared = await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(
                    folder.Id,
                    new PropertySchema
                    {
                        Inherit = true,
                        Properties = [new PropertyDefinition("stage", "Stage", PropertyType.Select, [], false)],
                    }),
                Cancellation);

            // It parses perfectly and then rejects every value anybody could give it, which looks
            // like a bug in the validator rather than an unfinished schema.
            Assert.True(declared.IsFailure);
            Assert.Equal("schema.invalid", declared.Error.Code);
        }
    }

    [Fact]
    public async Task Reading_a_schema_says_what_is_declared_here_and_what_is_inherited()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var child = await NewItemAsync(work, "Sub", folder.Id, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetEffectiveSchema, Result<EffectiveSchema>>(
                new GetEffectiveSchema(child.Id),
                Cancellation);

            Assert.True(read.IsSuccess);

            // An editor shown only the merged result would save the inherited property back onto
            // the child, silently turning inheritance into a copy - after which changing the
            // parent's schema would stop reaching it.
            Assert.NotNull(read.Value.Effective.Find("status"));
            Assert.Null(read.Value.Declared.Find("status"));
            Assert.False(read.Value.DeclaresSchema);
        }
    }

    [Fact]
    public async Task A_board_grouping_by_a_deleted_property_reports_itself_unrenderable()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var dispatcher = work.Resolve<NixDispatcher>();

            var stored = await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(
                    folder.Id,
                    [
                        new ViewDefinition(
                            "by-status",
                            "By status",
                            ViewKind.Board,
                            [],
                            "status",
                            [],
                            null,
                            null,
                            false),
                    ],
                    null),
                Cancellation);

            Assert.True(stored.IsSuccess, stored.IsSuccess ? "" : stored.Error.Message);

            var whileValid = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(folder.Id),
                Cancellation);
            Assert.Empty(whileValid.Value.Unrenderable);

            await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(folder.Id, PropertySchema.Empty),
                Cancellation);

            var afterDeletion = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(folder.Id),
                Cancellation);

            // Without this, the board renders empty - which is indistinguishable from an empty
            // folder, and sends somebody looking for their missing items rather than their missing
            // property.
            Assert.Contains("by-status", afterDeletion.Value.Unrenderable);
        }
    }

    [Fact]
    public async Task A_default_naming_a_view_that_is_not_being_stored_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();

            // Stored, it would resolve to the document on the very next read - so the person's
            // choice would appear to be taken and then quietly discarded. Refusing says so.
            var stored = await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(
                    folder.Id,
                    [new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false)],
                    "some-other-view"),
                Cancellation);

            Assert.True(stored.IsFailure);
            Assert.Equal("views.invalid", stored.Error.Code);
        }
    }

    [Fact]
    public async Task A_view_may_not_call_itself_the_document()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();

            // One field names either a view or the item's own body, so the word has to belong to
            // exactly one of them. Ids are slugs of names, and "Document" is a name somebody will
            // pick - without this it would become unreachable, shadowed by the body.
            var stored = await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(
                    folder.Id,
                    [new ViewDefinition("document", "Document", ViewKind.List, [], null, [], null, null, false)],
                    null),
                Cancellation);

            Assert.True(stored.IsFailure);
            Assert.Equal("views.invalid", stored.Error.Code);
        }
    }

    [Fact]
    public async Task The_view_that_opens_survives_storage()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(
                    folder.Id,
                    [
                        new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false),
                        new ViewDefinition(
                            "by-status",
                            "By status",
                            ViewKind.Board,
                            [],
                            "status",
                            [],
                            null,
                            null,
                            false),
                    ],
                    "by-status"),
                Cancellation);

            var read = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(folder.Id),
                Cancellation);

            Assert.True(read.IsSuccess);
            Assert.Equal("by-status", read.Value.Default);
        }
    }

    [Fact]
    public async Task A_container_with_no_views_opens_its_document()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();
            var read = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(folder.Id),
                Cancellation);

            Assert.True(read.IsSuccess);
            Assert.Equal("document", read.Value.Default);
        }
    }

    [Fact]
    public async Task A_board_with_no_grouping_property_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();

            var stored = await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(
                    folder.Id,
                    [new ViewDefinition("b", "Board", ViewKind.Board, [], null, [], null, null, false)],
                    null),
                Cancellation);

            Assert.True(stored.IsFailure);
            Assert.Equal("views.invalid", stored.Error.Code);
        }
    }

    [Fact]
    public async Task A_card_size_this_build_does_not_define_is_refused()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");

            var dispatcher = work.Resolve<NixDispatcher>();

            // The set is closed - small, medium, large - and unlike Mode, whose strays each kind
            // defaults, an unknown size has nothing to fall back to that anybody chose. Refused on
            // write, so the person typing "huge" hears about it now rather than reading a silently
            // medium gallery later.
            var stored = await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(
                    folder.Id,
                    [
                        new ViewDefinition(
                            "covers",
                            "Covers",
                            ViewKind.Gallery,
                            [],
                            null,
                            [],
                            null,
                            null,
                            false,
                            Mode: null,
                            CoverProperty: null,
                            EndDateProperty: null,
                            CardSize: "huge"),
                    ],
                    null),
                Cancellation);

            Assert.True(stored.IsFailure);
            Assert.Equal("views.invalid", stored.Error.Code);
        }
    }

    [Fact]
    public async Task Views_round_trip_through_storage()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.AlphaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var folder = await NewItemAsync(work, "Project", null, "folder");
            await DeclareStatusAsync(work, folder.Id);

            var dispatcher = work.Resolve<NixDispatcher>();

            await dispatcher.SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(
                    folder.Id,
                    [
                        new ViewDefinition("all", "All", ViewKind.List, ["status"], null, [], null, "status", true),
                        new ViewDefinition(
                            "by-status",
                            "By status",
                            ViewKind.Board,
                            [],
                            "status",
                            ["Doing", "Todo"],
                            null,
                            null,
                            false),
                    ],
                    null),
                Cancellation);

            var read = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(folder.Id),
                Cancellation);

            Assert.Equal(2, read.Value.Views.Length);
            Assert.Equal("All", read.Value.Views[0].Name);
            Assert.Equal(["status"], read.Value.Views[0].Columns);
            Assert.True(read.Value.Views[0].SortDescending);

            // The board's column order is the view's, not the schema's - the schema declares Todo
            // then Doing, and this board deliberately shows them the other way round.
            Assert.Equal(["Doing", "Todo"], read.Value.Views[1].GroupOrder);
        }
    }

    [Fact]
    public async Task A_schema_cannot_be_read_or_written_across_tenants()
    {
        var work = await _fixture.Application.BeginUnitOfWorkAsync(TestTenants.BetaContext, Cancellation);
        await using (work.ConfigureAwait(false))
        {
            var alphaItem = ItemId.From(M0SchemaSeed.Alpha.ItemId);
            var dispatcher = work.Resolve<NixDispatcher>();

            var read = await dispatcher.QueryAsync<GetEffectiveSchema, Result<EffectiveSchema>>(
                new GetEffectiveSchema(alphaItem),
                Cancellation);
            Assert.Equal("items.not_found", read.Error.Code);

            var written = await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
                new SetItemSchema(alphaItem, PropertySchema.Empty),
                Cancellation);
            Assert.Equal("items.not_found", written.Error.Code);

            var views = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(alphaItem),
                Cancellation);
            Assert.Equal("items.not_found", views.Error.Code);
        }
    }

    private static async Task DeclareStatusAsync(NixUnitOfWork work, ItemId itemId)
    {
        var dispatcher = work.Resolve<NixDispatcher>();
        var declared = await dispatcher.SendAsync<SetItemSchema, PropertySchema>(
            new SetItemSchema(
                itemId,
                new PropertySchema
                {
                    Inherit = true,
                    Properties =
                    [
                        new PropertyDefinition(
                            "status",
                            "Status",
                            PropertyType.Select,
                            ["Todo", "Doing", "Done"],
                            false),
                    ],
                }),
            Cancellation);

        Assert.True(declared.IsSuccess, declared.IsSuccess ? "" : declared.Error.Message);
    }

    private static async Task<Item> NewItemAsync(
        NixUnitOfWork work,
        string title,
        ItemId? parentId,
        string type = "note")
    {
        var dispatcher = work.Resolve<NixDispatcher>();
        var created = await dispatcher.SendAsync<CreateItem, Item>(
            new CreateItem(Workspace, type, title, parentId, null),
            Cancellation);

        Assert.True(created.IsSuccess, created.IsSuccess ? "" : created.Error.Message);
        return created.Value;
    }
}
