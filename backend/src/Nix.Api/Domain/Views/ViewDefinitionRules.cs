using System.Collections.Immutable;

namespace Nix.Domain.Views;

/// <summary>Pure storage rules shared by every view-writing boundary.</summary>
public static class ViewDefinitionRules
{
    /// <summary>The most filter rules one view may carry, counting those inside groups.</summary>
    public const int MaximumFilters = QueryRules.MaximumRules;

    /// <summary>The most keys one view may sort by.</summary>
    public const int MaximumSorts = 3;

    /// <summary>The most groups one view may remember as collapsed or limited.</summary>
    public const int MaximumGroupSettings = 64;

    /// <summary>The largest soft limit a group may carry.</summary>
    public const int MaximumGroupLimit = 999;

    /// <summary>The most column summaries one view may carry.</summary>
    public const int MaximumAggregates = 32;

    /// <summary>The most UTF-8 bytes a custom view's program may hold.</summary>
    public const int ProgramLimit = 32 * 1024;

    /// <summary>The longest property key or group value an arrangement field may name.</summary>
    public const int MaximumKeyLength = 128;

    /// <summary>The block kinds an interactive form page may declare.</summary>
    public static readonly ImmutableArray<string> FormBlockKinds = ["field", "heading", "paragraph"];

    /// <summary>The operators a form condition's <c>visibleWhen</c> may use.</summary>
    public static readonly ImmutableArray<string> FormConditionOperators =
        ["equals", "not_equals", "contains", "checked", "not_checked"];

    /// <summary>Returns the first reason a complete view set cannot be stored, or null.</summary>
    public static string? Refuse(ImmutableArray<ViewDefinition> views, string? defaultView)
    {
        if (views.Length > ViewDefinitionsJson.MaximumViews)
        {
            return $"A container may offer at most {ViewDefinitionsJson.MaximumViews} views.";
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var view in views)
        {
            if (view.Id.Length == 0)
            {
                return "Every view needs an identifier.";
            }

            if (!ids.Add(view.Id))
            {
                return $"'{view.Id}' is used by more than one view; a shared link names one view.";
            }

            if (view.Name.Length == 0)
            {
                return "Every view needs a name.";
            }

            if (string.Equals(view.Id, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal))
            {
                return $"'{ViewDefinitionsJson.DocumentView}' is reserved for the item's own body; "
                    + "give this view another name.";
            }

            if (ViewKinds.Find(view.Kind)?.Requirement is { } requirement
                && requirement.Read(view) is null)
            {
                if (view.Kind == ViewKind.Chart
                    && (view.Chart?.Period is not null || ChartKinds.NeedsTimeAxis(view.Chart?.Kind)))
                {
                    // Named apart so a period chart set through the API says what it is missing.
                    return $"'{view.Name}': a period chart (line, area, or any chart with a period) "
                        + "needs a date property to group by; set groupBy to one.";
                }

                return $"'{view.Name}': {requirement.Missing}.";
            }

            if (view.Kind == ViewKind.Matrix && string.IsNullOrEmpty(view.RowBy))
            {
                // The second axis the descriptor's one-field requirement cannot name.
                return $"'{view.Name}': a matrix needs a property for its rows.";
            }

            if (view.Program is { } program
                && System.Text.Encoding.UTF8.GetByteCount(program) > ProgramLimit)
            {
                return $"'{view.Name}': a custom view's program can be at most {ProgramLimit / 1024} KB.";
            }

            if (view.Measure is { } measure && !ChartMeasures.IsValid(measure))
            {
                return $"'{view.Name}': '{measure}' is not a measure a chart can draw; "
                    + $"use '{ChartMeasures.Count}' or '{ChartMeasures.Sum}'.";
            }

            if (view.Kind == ViewKind.Chart
                && string.Equals(view.Measure, ChartMeasures.Sum, StringComparison.Ordinal)
                && string.IsNullOrEmpty(view.MeasureProperty))
            {
                // A total with nothing to total draws every bar at zero, which looks like data.
                return $"'{view.Name}' totals a property, so it needs one to total.";
            }

            if (view.Chart?.Refuse() is { } chart)
            {
                return $"'{view.Name}': {chart}.";
            }

            if (view.CardSize is { } size && !GalleryCardSizes.IsValid(size))
            {
                return $"'{view.Name}': '{size}' is not a card size; "
                    + $"use '{GalleryCardSizes.Small}', '{GalleryCardSizes.Medium}' or '{GalleryCardSizes.Large}'.";
            }

            if (view.Open is { } open && !ViewOpenModes.IsValid(open))
            {
                return $"'{view.Name}': '{open}' is not an open mode; "
                    + $"use one of {string.Join(", ", ViewOpenModes.All.Select(mode => $"'{mode}'"))}.";
            }

            if (view.Layout is { } layout && !DriveLayouts.IsValid(layout))
            {
                return $"'{view.Name}': '{layout}' is not a layout; "
                    + $"use '{DriveLayouts.List}' or '{DriveLayouts.Grid}'.";
            }

            if (!view.HabitWidgets.IsDefaultOrEmpty)
            {
                if (view.HabitWidgets.Length > 12)
                {
                    return "A view may contain at most 12 habit charts.";
                }
                var widgetIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var widget in view.HabitWidgets)
                {
                    if (widget is null || string.IsNullOrWhiteSpace(widget.Id) || widget.Id.Length > 128 || !widgetIds.Add(widget.Id)
                        || widget.Kind is not ("completion" or "quantity" or "heatmap") || widget.HabitId == Guid.Empty
                        || widget.To < widget.From || widget.To.DayNumber - widget.From.DayNumber >= 366)
                    {
                        return "Habit charts need unique identifiers, a supported chart type, a habit, and an ordered range of at most 366 days.";
                    }
                }
            }

            // One check for every arrival of a rule set (QueryRules): the ceiling across groups,
            // one level of "any of", each rule's grammar, and structural fields on queries only.
            if (QueryRules.Refuse(view.Filters, view.Kind == ViewKind.Query) is { } filterReason)
            {
                return $"'{view.Name}': {filterReason}.";
            }

            if (RefuseArrangement(view) is { } arrangement)
            {
                return $"'{view.Name}': {arrangement}.";
            }
        }

        foreach (var view in views)
        {
            if (view.CompanionViewId is { } companion)
            {
                if (!ids.Contains(companion) || string.Equals(companion, view.Id, StringComparison.Ordinal))
                {
                    return $"'{view.Name}': its companion must name another view in this item.";
                }

                if (view.CompanionPlacement is not ("below" or "beside"))
                {
                    return $"'{view.Name}': a companion must be placed 'below' or 'beside'.";
                }

                var target = views.First(candidate => string.Equals(candidate.Id, companion, StringComparison.Ordinal));
                if (target.CompanionViewId is not null)
                {
                    return $"'{view.Name}': companion views cannot contain another companion.";
                }
            }
            else if (view.CompanionPlacement is not null)
            {
                return $"'{view.Name}': companion placement needs a companion view.";
            }

            if (view.Kind == ViewKind.InteractiveForm && RefuseForm(view.InteractiveForm) is { } formReason)
            {
                return $"'{view.Name}': {formReason}.";
            }
        }

        if (defaultView is { } chosen
            && chosen.Length > 0
            && !string.Equals(chosen, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal)
            && !ids.Contains(chosen))
        {
            return $"'{chosen}' is not one of these views, so it cannot be the one that opens.";
        }

        return null;
    }

    /// <summary>
    /// Returns why the document tab cannot be hidden for this view set, or null when the request is fine.
    /// </summary>
    /// <param name="views">The complete view set being stored.</param>
    /// <param name="defaultView">The default as requested: a view id, <c>document</c>, or null.</param>
    /// <param name="hideDocument">Whether the item's own document tab is to be hidden.</param>
    /// <returns>The first reason, or null.</returns>
    /// <remarks>
    /// Two refusals, both about leaving nothing to open. An item with no views has only its body, so
    /// hiding it would leave a blank item; and a default that explicitly names the document cannot
    /// stand beside a hidden document. An absent default is not refused, because absent already
    /// means "whatever opens" and <see cref="ViewDefinitionsJson.Write"/> then stores the first
    /// view. This hides a tab only; it is not an access control.
    /// </remarks>
    public static string? RefuseDocumentVisibility(
        ImmutableArray<ViewDefinition> views,
        string? defaultView,
        bool hideDocument)
    {
        if (!hideDocument)
        {
            return null;
        }

        if (views.IsDefaultOrEmpty)
        {
            return "The document tab can be hidden only for an item that offers at least one view.";
        }

        return string.Equals(defaultView, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal)
            ? "The document cannot be the view that opens while its tab is hidden."
            : null;
    }

    /// <summary>
    /// Refuses a malformed sort, collapsed-group, group-limit or summary list (ADR-0054).
    /// </summary>
    /// <remarks>
    /// Grammar and bounds only. Whether a key names a declared property is not asked, for the same
    /// reason a board's <c>GroupBy</c> is not: a view may be configured before its property is
    /// declared, and one naming a removed property draws without it rather than failing to save.
    /// </remarks>
    private static string? RefuseArrangement(ViewDefinition view)
    {
        if (!view.Sorts.IsDefaultOrEmpty)
        {
            if (view.Sorts.Length > MaximumSorts)
            {
                return $"a view may sort by at most {MaximumSorts} keys";
            }

            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var sort in view.Sorts)
            {
                if (sort is null || sort.Property.Length == 0 || sort.Property.Length > MaximumKeyLength)
                {
                    return "every sort needs a property key of at most "
                        + $"{MaximumKeyLength} characters";
                }

                if (!keys.Add(sort.Property))
                {
                    return $"'{sort.Property}' is sorted by more than once";
                }
            }
        }

        if (!view.CollapsedGroups.IsDefaultOrEmpty)
        {
            if (view.CollapsedGroups.Length > MaximumGroupSettings)
            {
                return $"a view may remember at most {MaximumGroupSettings} collapsed groups";
            }

            if (view.CollapsedGroups.Any(group => group is null || group.Length > MaximumKeyLength))
            {
                return $"a collapsed group's value may be at most {MaximumKeyLength} characters";
            }
        }

        if (!view.GroupLimits.IsDefaultOrEmpty)
        {
            if (view.GroupLimits.Length > MaximumGroupSettings)
            {
                return $"a view may limit at most {MaximumGroupSettings} groups";
            }

            var groups = new HashSet<string>(StringComparer.Ordinal);
            foreach (var limit in view.GroupLimits)
            {
                if (limit is null || limit.Group.Length > MaximumKeyLength || !groups.Add(limit.Group))
                {
                    return "each group may carry one limit, named by a value of at most "
                        + $"{MaximumKeyLength} characters";
                }

                if (limit.Limit < 1 || limit.Limit > MaximumGroupLimit)
                {
                    return $"a group's limit must be from 1 to {MaximumGroupLimit}";
                }
            }
        }

        if (!view.Aggregates.IsDefaultOrEmpty)
        {
            if (view.Aggregates.Length > MaximumAggregates)
            {
                return $"a view may summarise at most {MaximumAggregates} columns";
            }

            var columns = new HashSet<string>(StringComparer.Ordinal);
            foreach (var aggregate in view.Aggregates)
            {
                if (aggregate is null
                    || aggregate.Property.Length == 0
                    || aggregate.Property.Length > MaximumKeyLength
                    || !columns.Add(aggregate.Property))
                {
                    return "each column may carry one summary, named by a key of at most "
                        + $"{MaximumKeyLength} characters";
                }

                if (!ViewAggregateFunctions.IsValid(aggregate.Function))
                {
                    return $"'{aggregate.Function}' is not a summary a column can show";
                }
            }
        }

        return null;
    }

    private static string? RefuseForm(InteractiveFormDefinition? form)
    {
        if (form is null || form.Pages.IsDefaultOrEmpty)
        {
            return "an interactive form needs at least one page";
        }

        if (form.TitleMode is not ("generated" or "field"))
        {
            return "the response title must be generated or taken from a field";
        }

        var blockIds = new HashSet<string>(StringComparer.Ordinal);
        var fieldIds = new HashSet<string>(StringComparer.Ordinal);
        var earlierFields = new HashSet<string>(StringComparer.Ordinal);
        var pageIds = new HashSet<string>(StringComparer.Ordinal);
        var identityRoles = new HashSet<string>(StringComparer.Ordinal);
        foreach (var page in form.Pages)
        {
            if (page.Id.Length == 0 || !pageIds.Add(page.Id) || page.Blocks.IsDefaultOrEmpty)
            {
                return "every page needs a unique identifier and at least one block";
            }

            if (RefuseCondition(page.VisibleWhen, earlierFields) is { } pageCondition)
            {
                return $"page '{page.Id}' {pageCondition}";
            }

            foreach (var block in page.Blocks)
            {
                if (block.Id.Length == 0 || !blockIds.Add(block.Id))
                {
                    return "every form block needs a unique identifier";
                }

                if (block.Kind == "field" && string.IsNullOrWhiteSpace(block.PropertyKey))
                {
                    return $"field '{block.Id}' needs a property";
                }

                if (!FormBlockKinds.Contains(block.Kind))
                {
                    return $"'{block.Kind}' is not a form block kind";
                }

                if (RefuseCondition(block.VisibleWhen, earlierFields) is { } blockCondition)
                {
                    return $"block '{block.Id}' {blockCondition}";
                }

                if (block.IdentityRole is { } identityRole)
                {
                    if (block.Kind != "field" || identityRole is not ("name" or "email"))
                    {
                        return $"block '{block.Id}' has an invalid respondent identity role";
                    }

                    if (!identityRoles.Add(identityRole))
                    {
                        return $"respondent {identityRole} may be assigned to only one field";
                    }
                }

                if (block.Kind == "field")
                {
                    fieldIds.Add(block.Id);
                    earlierFields.Add(block.Id);
                }
            }
        }

        if (form.TitleMode == "field"
            && (form.TitleFieldBlockId is null || !fieldIds.Contains(form.TitleFieldBlockId)))
        {
            return "the response-title field must name a field block";
        }

        return null;
    }

    private static string? RefuseCondition(
        ImmutableArray<FormCondition> conditions,
        HashSet<string> earlierFields)
    {
        if (conditions.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var condition in conditions)
        {
            if (!earlierFields.Contains(condition.FieldBlockId))
            {
                return "has a condition that does not reference an earlier field";
            }

            if (!FormConditionOperators.Contains(condition.Operator))
            {
                return $"uses unknown condition operator '{condition.Operator}'";
            }
        }

        return null;
    }
}
