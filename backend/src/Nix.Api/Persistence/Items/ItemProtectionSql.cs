namespace Nix.Persistence.Items;

/// <summary>SQL fragments shared by the statements that decide what a file-version pin protects.</summary>
public static class ItemProtectionSql
{
    /// <summary>
    /// The one live-pin rule, as a predicate over an <c>item_reference</c> aliased <c>pin</c>: the
    /// reference pins a file version, and its holder and every ancestor of the holder (closure depth 0
    /// is the holder itself) are active. A pin held from the trash protects nothing.
    /// </summary>
    public const string LivePin = """
        pin.target_file_version_id IS NOT NULL
        AND NOT EXISTS (
            SELECT 1
              FROM item_closure up
              JOIN item holder ON holder.tenant_id = up.tenant_id AND holder.id = up.ancestor_id
             WHERE up.tenant_id = pin.tenant_id
               AND up.descendant_id = pin.holder_item_id
               AND holder.lifecycle_state <> 'active')
        """;
}
