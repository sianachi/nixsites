using System.Collections.Immutable;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Views;

namespace Nix.Tests.Domain.Templates;

public sealed class TemplateValidationTests
{
    [Fact]
    public void Portable_envelopes_preserve_other_modules_properties()
    {
        Assert.Null(new TemplateDefinitionValidator().ValidateEnvelope("{\"$habit_target\":3}", null, null));
    }

    [Fact]
    public void Schema_rules_reject_selects_without_options()
    {
        var schema = new PropertySchema
        {
            Inherit = true,
            Properties = [new PropertyDefinition("status", "Status", PropertyType.Select, [], false)],
        };

        Assert.Contains("at least one option", PropertySchemaRules.Refuse(schema), StringComparison.Ordinal);
    }

    [Fact]
    public void Schema_rules_reject_options_on_text_fields()
    {
        var schema = new PropertySchema
        {
            Inherit = true,
            Properties = [new PropertyDefinition("owner", "Owner", PropertyType.Text, ["A"], false)],
        };

        Assert.Contains("cannot carry options", PropertySchemaRules.Refuse(schema), StringComparison.Ordinal);
    }

    [Fact]
    public void View_rules_reject_a_default_that_does_not_exist()
    {
        var views = ImmutableArray.Create(
            new ViewDefinition("all", "All", ViewKind.List, [], null, [], null, null, false));

        Assert.Contains("cannot be the one that opens", ViewDefinitionRules.Refuse(views, "missing"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void View_rules_reject_conditions_that_reference_a_later_field()
    {
        var form = new InteractiveFormDefinition(
            [new FormPage(
                "page",
                "Page",
                null,
                [],
                [
                    new FormBlock(
                        "conditional",
                        "field",
                        "answer",
                        "Answer",
                        null,
                        false,
                        null,
                        [new FormCondition("later", "equals", "yes")]),
                    new FormBlock("later", "field", "later", "Later", null, false, null, []),
                ])],
            "generated",
            null,
            "Thanks",
            "Saved");
        var views = ImmutableArray.Create(
            new ViewDefinition(
                "form",
                "Form",
                ViewKind.InteractiveForm,
                [],
                null,
                [],
                null,
                null,
                false,
                InteractiveForm: form));

        Assert.Contains("earlier field", ViewDefinitionRules.Refuse(views, "form"), StringComparison.Ordinal);
    }

    // The Recipes-as-a-template bug: a working container's view listed a column its schema no
    // longer declared. The live product renders that column as nothing (ViewDefinition.CanRender
    // ignores columns), so capturing the container as a template must accept it too. Import stays
    // strict, because its content is external.
    [Fact]
    public void A_view_column_the_schema_does_not_declare_is_rejected_when_strict()
    {
        var reason = new TemplateDefinitionValidator()
            .ValidateViewDependencies(PropertySchema.Empty, CompanionWithDanglingColumn());

        Assert.NotNull(reason);
        Assert.Contains("does not declare", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void A_view_column_the_schema_does_not_declare_is_tolerated_when_capturing()
    {
        var reason = new TemplateDefinitionValidator()
            .ValidateViewDependencies(PropertySchema.Empty, CompanionWithDanglingColumn(), tolerateDrift: true);

        Assert.Null(reason);
    }

    [Fact]
    public void A_list_sectioned_by_a_checkbox_or_by_kind_and_a_matrix_pass_strict_validation()
    {
        // Lists and matrices take the wider section predicate, and a list's `$type` names each
        // item's body kind rather than a property, so neither is "undeclared" in the schema.
        var schema = new PropertySchema
        {
            Properties =
            [
                new PropertyDefinition("done", "Done", PropertyType.Checkbox, [], Required: false),
                new PropertyDefinition("status", "Status", PropertyType.Select, ["Open"], Required: false),
            ],
            Inherit = true,
        };
        var views = new StoredViews(
            [
                new ViewDefinition("a", "By done", ViewKind.List, [], "done", [], null, null, false, Filters: []),
                new ViewDefinition("b", "By kind", ViewKind.List, [], "$type", [], null, null, false, Filters: []),
                new ViewDefinition("c", "Grid", ViewKind.Matrix, [], "status", [], null, null, false, Filters: [], RowBy: "done"),
            ],
            null);

        Assert.Null(new TemplateDefinitionValidator().ValidateViewDependencies(schema, views));
    }

    [Fact]
    public void A_custom_view_needs_nothing_from_the_schema_and_keeps_its_program_in_the_stored_json()
    {
        var custom = new ViewDefinition("a", "Mine", ViewKind.Custom, [], null, [], null, null, false, Filters: [], Program: "root = Stack([])");

        Assert.Null(new TemplateDefinitionValidator().ValidateViewDependencies(
            PropertySchema.Empty,
            new StoredViews([custom], null)));
        var copied = ViewDefinitionsJson.Read(ViewDefinitionsJson.Write([custom])).Views;
        Assert.Equal("root = Stack([])", Assert.Single(copied).Program);
    }

    [Fact]
    public void A_board_by_a_checkbox_and_a_matrix_with_free_text_rows_fail_strict_validation()
    {
        var schema = new PropertySchema
        {
            Properties =
            [
                new PropertyDefinition("done", "Done", PropertyType.Checkbox, [], Required: false),
                new PropertyDefinition("status", "Status", PropertyType.Select, ["Open"], Required: false),
                new PropertyDefinition("notes", "Notes", PropertyType.Text, [], Required: false),
            ],
            Inherit = true,
        };
        var validator = new TemplateDefinitionValidator();

        Assert.NotNull(validator.ValidateViewDependencies(
            schema,
            new StoredViews([new ViewDefinition("a", "Board", ViewKind.Board, [], "done", [], null, null, false)], null)));
        Assert.NotNull(validator.ValidateViewDependencies(
            schema,
            new StoredViews(
                [new ViewDefinition("c", "Grid", ViewKind.Matrix, [], "status", [], null, null, false, RowBy: "notes")],
                null)));
    }

    private static StoredViews CompanionWithDanglingColumn() =>
        new(
            [
                new ViewDefinition(
                    "companion",
                    "Companion",
                    ViewKind.List,
                    ["ingredient"],
                    null,
                    [],
                    null,
                    null,
                    false),
            ],
            null);
}
