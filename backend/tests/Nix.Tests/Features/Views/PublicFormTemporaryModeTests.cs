using System.Net;
using System.Text;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Features.Views;
using Nix.Messaging;
using Nix.Tests.Features.Query;
using Nix.Tests.Harness;

namespace Nix.Tests.Features.Views;

public sealed class PublicFormTemporaryModeTests(ContractHostFactory factory)
    : IClassFixture<ContractHostFactory>
{
    [Fact]
    public async Task Temporary_forms_cannot_be_published_or_report_an_active_link()
    {
        var item = FormItem("temporary");
        await using var store = new ExistingLinkStore(item);
        await using var isolated = Host(item, store);
        using var client = isolated.CreateClient();
        var path = new Uri($"/api/v1/items/{item.Id.Value}/views/form/public-link", UriKind.Relative);
        using var publish = await client.PutAsync(path, null, TestContext.Current.CancellationToken);
        using var status = await client.GetAsync(path, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, publish.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, status.StatusCode);
        Assert.Equal(0, store.Writes);
    }

    [Theory]
    [InlineData(null, HttpStatusCode.OK)]
    [InlineData("temporary", HttpStatusCode.NotFound)]
    public async Task Public_links_use_the_current_form_storage_mode(string? mode, HttpStatusCode expected)
    {
        var item = FormItem(mode);
        await using var store = new ExistingLinkStore(item);
        await using var isolated = Host(item, store);
        using var client = isolated.CreateClient();
        var token = Tokens().Create(item.TenantId, store.Link.Id, store.Link.SubmissionPrincipalId, store.Link.Nonce);

        using var response = await client.GetAsync(
            new Uri($"/public/v1/forms/{token}", UriKind.Relative),
            TestContext.Current.CancellationToken);

        Assert.Equal(expected, response.StatusCode);
        Assert.Equal(0, store.Writes);
    }

    [Fact]
    public async Task An_existing_public_link_cannot_submit_after_the_form_becomes_temporary()
    {
        var item = FormItem("temporary");
        await using var store = new ExistingLinkStore(item);
        await using var isolated = Host(item, store);
        using var client = isolated.CreateClient();
        var token = Tokens().Create(item.TenantId, store.Link.Id, store.Link.SubmissionPrincipalId, store.Link.Nonce);
        using var content = new StringContent("""{"answers":{}}""", Encoding.UTF8, "application/json");

        using var response = await client.PostAsync(
            new Uri($"/public/v1/forms/{token}", UriKind.Relative),
            content,
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, store.Writes);
        Assert.Equal(0, store.Commits);
    }

    [Fact]
    public async Task An_unavailable_response_parent_refuses_submission_before_any_write()
    {
        var item = FormItem("saved");
        await using var store = new ExistingLinkStore(item, lockAvailable: false);
        await using var isolated = Host(item, store);
        using var client = isolated.CreateClient();
        var token = Tokens().Create(item.TenantId, store.Link.Id, store.Link.SubmissionPrincipalId, store.Link.Nonce);
        using var content = new StringContent("""{"answers":{}}""", Encoding.UTF8, "application/json");
        using var response = await client.PostAsync(new Uri($"/public/v1/forms/{token}", UriKind.Relative),
            content, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(1, store.Locks);
        Assert.Equal(0, store.Writes);
        Assert.Equal(0, store.Commits);
    }

    [Fact]
    public async Task An_invalid_capability_never_acquires_a_submission_lock()
    {
        var item = FormItem("saved");
        await using var store = new ExistingLinkStore(item);
        await using var isolated = Host(item, store);
        using var client = isolated.CreateClient();
        var token = Tokens().Create(item.TenantId, store.Link.Id, store.Link.SubmissionPrincipalId, "wrong-nonce");
        using var content = new StringContent("""{"answers":{}}""", Encoding.UTF8, "application/json");
        using var response = await client.PostAsync(new Uri($"/public/v1/forms/{token}", UriKind.Relative),
            content, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, store.Locks);
        Assert.Equal(0, store.Writes);
    }

    private WebApplicationFactory<Program> Host(Item item, ExistingLinkStore store) =>
        factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<IItemTree>(new StubTree(item));
            services.AddSingleton<IPublicFormStore>(store);
            services.AddSingleton<ISchemaResolver>(new EmptySchemas());
            services.AddSingleton<IPermissionResolver>(new StubPermissions([item.WorkspaceId]));
            services.AddSingleton<IVisibleItems>(new Nix.Features.Items.VisibleItems(
                new StubTree(item), new StubPermissions([item.WorkspaceId]), new Nix.Tests.Support.OpenLocks()));
            services.AddSingleton<INixSessionContextAccessor>(new StubSession(
                NixSessionContext.ForTenant(item.TenantId, item.CreatedBy)));
            services.AddSingleton(Tokens());
            services.AddScoped<NixDispatcher>();
            services.AddSingleton<ICommandHandler<CreateStructuredItem, Item>>(new SuccessfulSetup(item));
        }));

    private static PublicFormTokenService Tokens() =>
        new(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [PublicFormTokenService.SigningKeyConfiguration] = "a-test-signing-key-that-is-at-least-thirty-two-bytes",
        }).Build());

    [Fact]
    public async Task Structured_setup_cannot_publish_a_temporary_form_or_write_a_link()
    {
        var item = FormItem("temporary");
        await using var store = new ExistingLinkStore(item);
        await using var isolated = Host(item, store);
        using var client = isolated.CreateClient();
        using var request = new StringContent("""
            {
              "type":"note", "title":"Calculator",
              "schema":{"properties":[],"inherit":true},
              "views":{"views":[{"id":"form","name":"Form","kind":"interactive_form",
                "mode":"temporary","columns":[],"groupOrder":[],"sortDescending":false,
                "interactiveForm":{"pages":[{"id":"page","title":"Page","visibleWhen":[],
                  "blocks":[{"id":"intro","kind":"paragraph","text":"Calculate here",
                    "required":false,"visibleWhen":[]}]}],
                  "titleMode":"generated","confirmationTitle":"Thanks","confirmationMessage":"Done"}}],
                "default":"form"},
              "publishInteractiveFormViewId":"form"
            }
            """, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync(
            new Uri($"/api/v1/workspaces/{item.WorkspaceId.Value}/structured-items", UriKind.Relative),
            request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var setup = Assert.IsType<SuccessfulSetup>(isolated.Services.GetRequiredService<ICommandHandler<CreateStructuredItem, Item>>());
        Assert.Equal(1, setup.Calls);
        Assert.Equal(0, store.Writes);
        Assert.Equal(0, store.Commits);
    }

    private static Item FormItem(string? mode)
    {
        var principal = PrincipalId.Create();
        var view = new ViewDefinition(
            "form", "Form", ViewKind.InteractiveForm, [], null, [], null, null, false,
            Mode: mode,
            InteractiveForm: new InteractiveFormDefinition(
                [new FormPage("page", "Page", null, [], [new FormBlock("intro", "paragraph", null, "Calculate here", null, false, null, [])])], "generated", null, "Thanks", "Done"));
        return new Item
        {
            Id = ItemId.Create(),
            TenantId = TenantId.Create(),
            WorkspaceId = WorkspaceId.Create(),
            Type = "note",
            Seq = 1,
            LifecycleState = ItemLifecycleState.Active,
            Views = ViewDefinitionsJson.Write([view]),
            CreatedBy = principal,
            LastModifiedBy = principal,
            CreatedAt = DateTimeOffset.UnixEpoch,
            LastModifiedAt = DateTimeOffset.UnixEpoch,
        };
    }

    private sealed class SuccessfulSetup(Item item) : ICommandHandler<CreateStructuredItem, Item>
    {
        internal int Calls { get; private set; }

        public ValueTask<Result<Item>> HandleAsync(CreateStructuredItem command, CancellationToken cancellationToken)
        {
            Calls++;
            return ValueTask.FromResult(Result.Success(item));
        }
    }

    private sealed class EmptySchemas : ISchemaResolver
    {
        public ValueTask<PropertySchema> ResolveForItemAsync(ItemId itemId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(PropertySchema.Empty);

        public ValueTask<PropertySchema> ResolveForChildrenAsync(ItemId? parentId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(PropertySchema.Empty);
    }

    private sealed class ExistingLinkStore(Item item, bool lockAvailable = true) : IPublicFormStore, IPublicFormTransaction
    {
        internal PublicFormLink Link { get; } = new()
        {
            Id = Guid.CreateVersion7(),
            TenantId = item.TenantId,
            WorkspaceId = item.WorkspaceId,
            ItemId = item.Id,
            ViewId = "form",
            Nonce = "existing-link-nonce",
            SubmissionPrincipalId = PrincipalId.Create(),
            PublishedBy = item.CreatedBy,
            PublishedAt = DateTimeOffset.UnixEpoch,
        };

        internal int Writes { get; private set; }

        internal int Commits { get; private set; }

        internal int Locks { get; private set; }

        public ValueTask<IPublicFormTransaction> BeginAsync(NixSessionContext context, CancellationToken cancellationToken) =>
            ValueTask.FromResult<IPublicFormTransaction>(this);

        public ValueTask<PublicFormLink?> FindAsync(Guid linkId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<PublicFormLink?>(linkId == Link.Id ? Link : null);

        public ValueTask<bool> IsActivePrincipalAsync(PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(principalId == Link.SubmissionPrincipalId);

        public ValueTask<bool> LockSubmissionAsync(PublicFormLink link, CancellationToken cancellationToken)
        {
            Locks++;
            return ValueTask.FromResult(lockAvailable && link.ItemId == item.Id);
        }

        public ValueTask<PublicFormLink?> FindForUpdateAsync(ItemId itemId, string viewId, CancellationToken cancellationToken) =>
            ValueTask.FromResult<PublicFormLink?>(itemId == Link.ItemId && viewId == Link.ViewId ? Link : null);

        public void Add(PublicFormLink link, Principal principal, WorkspaceMember membership) => Writes++;

        public void AddAudit(AuditEvent auditEvent) => Writes++;

        public Task SaveAsync(CancellationToken cancellationToken)
        {
            Writes++;
            return Task.CompletedTask;
        }

        public Task CommitAsync(CancellationToken cancellationToken)
        {
            Commits++;
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
