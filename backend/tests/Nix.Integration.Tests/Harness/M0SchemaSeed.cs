using System.Globalization;
using Nix.Domain.Identity;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// One row in every M0 table, for each of the two tenants.
/// </summary>
/// <remarks>
/// <para>
/// Written as the migrator, which holds <c>BYPASSRLS</c>, because seeding both tenants is exactly
/// the thing the policies are supposed to make impossible for anyone else. Doing it through the
/// application's own path would need two sessions and would make the setup depend on the
/// mechanism under test.
/// </para>
/// <para>
/// One row per table is enough and more would be worse: an isolation test asserts a count of one
/// against a table that holds two rows, and any number larger than that only makes a failure
/// harder to read.
/// </para>
/// </remarks>
internal static class M0SchemaSeed
{
    /// <summary>The rows belonging to the first tenant.</summary>
    public static readonly M0TenantRows Alpha = new(
        TenantId: TestTenants.Alpha,
        WorkspaceId: TestTenants.AlphaWorkspace,
        PrincipalId: TestTenants.AlphaPrincipal,
        GroupId: new Guid("1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c"),
        ProviderId: new Guid("1d1d1d1d-1111-4111-8111-1d1d1d1d1d1d"),
        InvitationId: new Guid("15151515-1111-4111-8111-151515151515"),
        ItemId: new Guid("1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e"),
        AclEntryId: new Guid("1f1f1f1f-1111-4111-8111-1f1f1f1f1f1f"),
        AuditEventId: new Guid("19191919-1111-4111-8111-191919191919"),
        ContentDocId: new Guid("1d0c1d0c-1111-4111-8111-1d0c1d0c1d0c"),
        TemplateId: new Guid("1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a"),
        TemplateOperationId: new Guid("1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b"),
        TemplateApplicationId: new Guid("18181818-1111-4111-8111-181818181818"),
        TemplateSourceId: new Guid("17171717-1111-4111-8111-171717171717"),
        Slug: "alpha");

    /// <summary>The rows belonging to the second tenant - the ones that must never be visible.</summary>
    public static readonly M0TenantRows Beta = new(
        TenantId: TestTenants.Beta,
        WorkspaceId: TestTenants.BetaWorkspace,
        PrincipalId: TestTenants.BetaPrincipal,
        GroupId: new Guid("2c2c2c2c-2222-4222-8222-2c2c2c2c2c2c"),
        ProviderId: new Guid("2d2d2d2d-2222-4222-8222-2d2d2d2d2d2d"),
        InvitationId: new Guid("25252525-2222-4222-8222-252525252525"),
        ItemId: new Guid("2e2e2e2e-2222-4222-8222-2e2e2e2e2e2e"),
        AclEntryId: new Guid("2f2f2f2f-2222-4222-8222-2f2f2f2f2f2f"),
        AuditEventId: new Guid("29292929-2222-4222-8222-292929292929"),
        ContentDocId: new Guid("2d0c2d0c-2222-4222-8222-2d0c2d0c2d0c"),
        TemplateId: new Guid("2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a"),
        TemplateOperationId: new Guid("2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b"),
        TemplateApplicationId: new Guid("28282828-2222-4222-8222-282828282828"),
        TemplateSourceId: new Guid("27272727-2222-4222-8222-272727272727"),
        Slug: "beta");

    /// <summary>
    /// Seeds both tenants' rows into every M0 table.
    /// </summary>
    /// <param name="fixture">The database fixture.</param>
    /// <returns>A task that completes when both tenants are present.</returns>
    public static async Task SeedBothTenantsAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, InsertSqlFor(Alpha));
            await RawSql.ExecuteAsync(connection, transaction: null, InsertSqlFor(Beta));
        }
    }

    /// <summary>
    /// Locks each tenant's seeded item and issues one unlock grant, so the lock tables have a row
    /// per tenant for the isolation theories to filter.
    /// </summary>
    /// <param name="fixture">The database fixture.</param>
    /// <returns>A task that completes when both tenants' lock rows are present.</returns>
    /// <remarks>
    /// Separate from <see cref="SeedBothTenantsAsync"/> on purpose. A lock withholds the seeded
    /// item's body from search, backlinks and the collaboration service's authorization, which
    /// dozens of other suites exercise against that same item; seeding one for everybody would
    /// change what each of them sees. Only the suites that need the rows ask for them.
    /// </remarks>
    public static async Task SeedItemLocksAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var rows in new[] { Alpha, Beta })
            {
                var tenant = Literal(rows.TenantId);
                var item = Literal(rows.ItemId);
                var principal = Literal(rows.PrincipalId);
                await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"""
                    INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
                    VALUES ({item}, {tenant},
                            'pbkdf2-sha256$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                            {principal}, now());

                    INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
                    VALUES ({item}, {principal}, {tenant}, {principal}, now() + interval '15 minutes');
                    """);
            }
        }
    }

    /// <summary>
    /// Seeds one named history version per tenant for schema-isolation coverage.
    /// </summary>
    /// <param name="fixture">The database fixture.</param>
    /// <returns>A task that completes when both tenants' version rows are present.</returns>
    /// <remarks>
    /// Kept separate from <see cref="SeedBothTenantsAsync"/> because older-migration upgrade
    /// tests intentionally seed a schema from before <c>content_version</c> existed.
    /// </remarks>
    public static async Task SeedContentVersionsAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var rows in new[] { Alpha, Beta })
            {
                await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"""
                    INSERT INTO content_version
                        (doc_id, seq, tenant_id, name, created_by, created_at)
                    VALUES ({Literal(rows.ContentDocId)}, 1, {Literal(rows.TenantId)},
                            '{rows.Slug} seed version', {Literal(rows.PrincipalId)}, now());
                    """);
            }
        }
    }

    /// <summary>
    /// Seeds one site per tenant with a row in every sites table that the runtime role may update,
    /// so the cross-tenant write theory has a row to relabel in each of them.
    /// </summary>
    /// <param name="fixture">The database fixture.</param>
    /// <returns>A task that completes when both tenants' site rows are present.</returns>
    /// <remarks>Separate from the base seed because upgrade tests also seed schemas from before sites existed.</remarks>
    public static async Task SeedSitesAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            foreach (var rows in new[] { Alpha, Beta })
            {
                var tenant = Literal(rows.TenantId);
                var workspace = Literal(rows.WorkspaceId);
                var item = Literal(rows.ItemId);
                var principal = Literal(rows.PrincipalId);
                var site = Literal(SiteIdFor(rows));
                var build = Literal(BuildIdFor(rows));
                await RawSql.ExecuteAsync(
                    connection,
                    transaction: null,
                    $"""
                    INSERT INTO site
                        (tenant_id, id, workspace_id, root_item_id, slug, layout, settings, republish_mode,
                         debounce_seconds, status, created_by, created_at, updated_at)
                    VALUES ({tenant}, {site}, {workspace}, {item}, 'seed-{rows.Slug}', 'docs', jsonb_build_object(),
                            'manual', 300, 'draft', {principal}, now(), now());

                    INSERT INTO site_hostname (tenant_id, hostname, site_id, kind, verified_at, created_at)
                    VALUES ({tenant}, 'seed-{rows.Slug}.sites.example.test', {site}, 'default', now(), now());

                    INSERT INTO site_exclusion (tenant_id, site_id, item_id) VALUES ({tenant}, {site}, {item});

                    INSERT INTO site_dated_collection (tenant_id, site_id, item_id, date_property)
                    VALUES ({tenant}, {site}, {item}, 'date');

                    INSERT INTO site_page (tenant_id, site_id, item_id, path, pinned, created_at, updated_at)
                    VALUES ({tenant}, {site}, {item}, '/', false, now(), now());

                    INSERT INTO site_redirect (tenant_id, site_id, from_path, item_id, created_at)
                    VALUES ({tenant}, {site}, '/old/', {item}, now());

                    INSERT INTO site_build
                        (tenant_id, id, site_id, status, job_id, publisher_id, origin, idempotency_key, header,
                         page_count, file_count, total_bytes, loss, created_at)
                    VALUES ({tenant}, {build}, {site}, 'queued', gen_random_uuid(), {principal}, 'manual',
                            'seed', jsonb_build_object(), 1, 0, 0, '[]'::jsonb, now());

                    INSERT INTO site_build_page
                        (tenant_id, build_id, ordinal, item_id, path, title, type, seq, item_created_at,
                         item_updated_at, properties, property_files)
                    VALUES ({tenant}, {build}, 0, {item}, '/', 'Seed', 'folder', 1000, now(), now(),
                            jsonb_build_object(), '[]'::jsonb);

                    INSERT INTO site_build_file
                        (tenant_id, build_id, source_item_id, file_item_id, file_version_id, sha256, media_type,
                         byte_length, created_at)
                    VALUES ({tenant}, {build}, {item}, {item}, gen_random_uuid(), repeat('a', 64), 'image/png',
                            10, now());

                    INSERT INTO site_build_object (tenant_id, build_id, key, sha256, byte_length, kind, created_at)
                    VALUES ({tenant}, {build}, 'sites/seed/index.html', repeat('a', 64), 1, 'build', now());

                    INSERT INTO site_activation
                        (tenant_id, id, site_id, job_id, build_id, reason, generation, ops, created_at)
                    VALUES ({tenant}, gen_random_uuid(), {site}, gen_random_uuid(), {build}, 'publish', 1,
                            '[]'::jsonb, now());

                    INSERT INTO site_operator (tenant_id, principal_id, granted_by, granted_at)
                    VALUES ({tenant}, {principal}, {principal}, now());
                    """);
            }
        }
    }

    /// <summary>The seeded site of a tenant.</summary>
    public static Guid SiteIdFor(M0TenantRows rows) =>
        rows.Slug == "alpha" ? new Guid("51e51e51-1111-4111-8111-51e51e51e51e") : new Guid("51e51e51-2222-4222-8222-51e51e51e51e");

    /// <summary>The seeded build of a tenant's seeded site.</summary>
    public static Guid BuildIdFor(M0TenantRows rows) =>
        rows.Slug == "alpha" ? new Guid("b0b0b0b0-1111-4111-8111-b0b0b0b0b0b0") : new Guid("b0b0b0b0-2222-4222-8222-b0b0b0b0b0b0");

    /// <summary>Seeds newer tables for the current-schema isolation tests.</summary>
    /// <remarks>Separate from the base seed because upgrade tests also seed older schemas.</remarks>
    public static async Task SeedCurrentSchemaRowsAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);
        await using var connection = await fixture.OpenMigratorConnectionAsync();
        foreach (var rows in new[] { Alpha, Beta })
        {
            await RawSql.ExecuteAsync(connection, transaction: null, $"""
                INSERT INTO item_creation_receipt (tenant_id, principal_id, request_key, request_hash, item_id)
                VALUES ({Literal(rows.TenantId)}, {Literal(rows.PrincipalId)}, {Literal(rows.ItemId)},
                    sha256(convert_to(jsonb_build_object()::text, 'UTF8')), {Literal(rows.ItemId)});

                INSERT INTO workspace_arrangement
                    (tenant_id, principal_id, groups_json, pinned_workspace_ids, revision)
                VALUES ({Literal(rows.TenantId)}, {Literal(rows.PrincipalId)}, '[]'::jsonb, ARRAY[]::uuid[], 1);

                INSERT INTO principal_ui_settings (tenant_id, principal_id, settings, revision)
                VALUES ({Literal(rows.TenantId)}, {Literal(rows.PrincipalId)}, jsonb_build_object(), 1);

                INSERT INTO pet_provider_credential
                    (tenant_id, principal_id, provider, protected_key, key_hint, saved_at)
                VALUES ({Literal(rows.TenantId)}, {Literal(rows.PrincipalId)}, 'anthropic',
                    decode('0102', 'hex'), 'seed', now());
                """);
        }
    }

    private static string InsertSqlFor(M0TenantRows rows)
    {
        // Insertion order follows the foreign keys: the tenant, then what hangs off it, then the
        // item, then what hangs off the item.
        var tenant = Literal(rows.TenantId);
        var workspace = Literal(rows.WorkspaceId);
        var principal = Literal(rows.PrincipalId);
        var group = Literal(rows.GroupId);
        var provider = Literal(rows.ProviderId);
        var invitation = Literal(rows.InvitationId);
        var browserSession = invitation;
        var item = Literal(rows.ItemId);
        var acl = Literal(rows.AclEntryId);
        var auditEvent = Literal(rows.AuditEventId);
        var contentDoc = Literal(rows.ContentDocId);
        var template = Literal(rows.TemplateId);
        var templateOperation = Literal(rows.TemplateOperationId);
        var templateApplication = Literal(rows.TemplateApplicationId);
        var templateSource = Literal(rows.TemplateSourceId);
        var slug = rows.Slug;
        const string automationTrigger = """{"type":"schedule","freq":"daily","interval":1,"time":"09:00","startDate":"2026-01-01"}""";
        const string automationActions = """[{"type":"notify","title":"Seeded","body":""}]""";
        var pluginDigest = new string(slug == "alpha" ? 'A' : 'B', 64);
        var browserSessionHash = new string(slug == "alpha" ? 'a' : 'b', BrowserSession.TokenHashLength);

        return $"""
            INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
            VALUES ({tenant}, '{slug}', 'shared', now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({workspace}, {tenant}, '{slug} workspace', 30, 10, 1073741824, now());

            INSERT INTO principal
                (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                 email, email_normalized, email_verified, status, deprovisioned_at)
            VALUES ({principal}, {tenant}, 'https://issuer.{slug}.test', '{slug}-subject', 'user',
                    '{slug} user', '{slug}@example.test', '{slug}@example.test', true,
                    'active', NULL);

            INSERT INTO browser_session
                (session_id, tenant_id, principal_id, token_hash, created_at, expires_at, revoked_at)
            VALUES ({browserSession}, {tenant}, {principal}, '{browserSessionHash}', now(),
                    now() + interval '8 hours', NULL);

            INSERT INTO principal_group (group_id, tenant_id, name, external_id)
            VALUES ({group}, {tenant}, '{slug} group', '{slug}-external');

            INSERT INTO identity_provider
                (provider_id, tenant_id, issuer, audience, jwks_uri, allowed_algorithms, enabled,
                 jit_provisioning_enabled, userinfo_uri)
            VALUES ({provider}, {tenant}, 'https://issuer.{slug}.test', 'nix-api',
                    'https://issuer.{slug}.test/keys', ARRAY['RS256']::text[], true, false,
                    'https://issuer.{slug}.test/userinfo');

            INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
            VALUES ({group}, {principal}, {tenant}, 'directory');

            INSERT INTO tenant_role
                (tenant_id, subject_type, subject_id, role, granted_by, granted_at)
            VALUES ({tenant}, 'principal', {principal}, 'admin', {principal}, now());

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({workspace}, 'principal', {principal}, {tenant}, 'editor', {principal}, now());

            INSERT INTO workspace_invitation
                (invitation_id, tenant_id, workspace_id, email_normalized, role,
                 invited_by_principal_id, status, invited_at)
            VALUES ({invitation}, {tenant}, {workspace}, 'pending-{slug}@example.test', 'viewer',
                    {principal}, 'pending', now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ({item}, {tenant}, {workspace}, 'folder', NULL, 1000, NULL, 'active', NULL,
                    {principal}, {principal}, now(), now());

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ({item}, {item}, {tenant}, {workspace}, 0);

            INSERT INTO acl_entry
                (acl_entry_id, item_id, tenant_id, workspace_id, subject_type, subject_id, role,
                 effect, breaks_inheritance)
            VALUES ({acl}, {item}, {tenant}, {workspace}, 'principal', {principal}, 'editor',
                    'allow', false);

            INSERT INTO audit_event
                (event_id, tenant_id, workspace_id, actor_id, on_behalf_of, action, subject_id,
                 subject_type, before, after, actor_ip, occurred_at)
            VALUES ({auditEvent}, {tenant}, {workspace}, {principal}, NULL, 'item.created',
                    {item}, 'item', NULL, jsonb_build_object('type', 'folder'),
                    '203.0.113.10'::inet, now());

            INSERT INTO content_doc
                (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
            VALUES ({contentDoc}, {tenant}, {item}, {workspace}, 1, 1, now());

            -- One update, so the log is not empty and the isolation theory has a row to filter.
            -- The bytes are not a real CRDT payload: nothing in Core interprets them, and the
            -- collaboration service's own tests use real ones.
            INSERT INTO content_update
                (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
            VALUES ({contentDoc}, 1, {tenant}, '\\x0102'::bytea, {principal}, '{slug}-client', now());

            INSERT INTO content_snapshot
                (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
            VALUES ({contentDoc}, 1, {tenant}, '\\x0102'::bytea, NULL, '{slug} note body', now());

            INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_vector)
            VALUES ({tenant}, {item}, 1, now(), to_tsvector('english', '{slug} note body'));

            -- Upgrade tests also seed schemas from before retrieval chunks existed.
            DO $chunks$
            BEGIN
                IF to_regclass('public.item_chunk') IS NOT NULL THEN
                    INSERT INTO item_chunk (tenant_id, item_id, ord, seq, heading, body, content_hash, body_vector)
                    VALUES ({tenant}, {item}, 0, 1, '', '{slug} note body', '{slug}', to_tsvector('english', '{slug} note body'));
                END IF;
            END $chunks$;

            -- A self-edge, which extraction never produces: a document linking to itself is
            -- dropped precisely so it cannot appear in its own backlinks panel. It is used here
            -- because the seed holds exactly one item per tenant and every isolation theory in
            -- this suite asserts a count of one against each table - seeding a second item to
            -- make this edge realistic would change what ten other test classes see. What is
            -- being proved here is that the row carries a tenant and the policy honours it,
            -- and a self-edge proves that as well as any other pair would.
            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES ({tenant}, {item}, {item}, 1, 1);

            -- Upgrade tests also seed schemas from before companion preferences existed.
            DO $pets$
            BEGIN
                IF to_regclass('public.pet_preferences') IS NOT NULL THEN
                    INSERT INTO pet_preferences (principal_id, tenant_id, settings, revision)
                    VALUES ({principal}, {tenant}, jsonb_build_object(
                        'enabled', false, 'activePetId', NULL, 'motion', 'system',
                        'narration', false, 'profiles', jsonb_build_array()), 1);
                END IF;
            END $pets$;

            -- One library per principal, and the seeded principal gets theirs. Present so the
            -- isolation theories have a row to see and a row to try to relabel; the contents are
            -- opaque to Core, so an empty array says as much as anything else would.
            INSERT INTO canvas_library (principal_id, tenant_id, library_items, updated_at)
            VALUES ({principal}, {tenant}, '[]'::jsonb, now());

            -- The seeded principal keeps the seeded item. Present for the same reason the library
            -- above is: the isolation theories need a row to see and a row to try to relabel. The
            -- seed holds one item per tenant, so this is the only pair there is to make.
            INSERT INTO bookmark (principal_id, tenant_id, item_id, created_at)
            VALUES ({principal}, {tenant}, {item}, now());

            -- Upgrade tests also seed schemas from before reminders and the inbox existed.
            DO $notifications$
            BEGIN
                IF to_regclass('public.principal_preferences') IS NOT NULL THEN
                    INSERT INTO principal_preferences
                        (tenant_id, principal_id, time_zone, quiet_start, quiet_end,
                         due_reminder_time, due_reminders, habit_reminders, muted_container_ids, revision)
                    VALUES ({tenant}, {principal}, 'Etc/UTC', NULL, NULL, '09:00', true, true, ARRAY[]::uuid[], 1);
                END IF;

                IF to_regclass('public.notification') IS NOT NULL THEN
                    INSERT INTO notification
                        (tenant_id, id, principal_id, kind, title, body, item_id, workspace_id, created_at, dedupe_key)
                    VALUES ({tenant}, {auditEvent}, {principal}, 'system', '{slug} notification',
                            '{slug} notification body', {item}, {workspace}, now(), '{slug}-notification-seed');
                END IF;

                IF to_regclass('public.push_subscription') IS NOT NULL THEN
                    INSERT INTO push_subscription
                        (tenant_id, id, principal_id, endpoint, p256dh, auth, user_agent, created_at, last_success_at, failures)
                    VALUES ({tenant}, {acl}, {principal}, 'https://fcm.googleapis.com/fcm/send/{slug}',
                            '{new string(slug == "alpha" ? 'p' : 'q', 87)}', '{new string(slug == "alpha" ? 'k' : 'j', 22)}',
                            '{slug}-agent', now(), NULL, 0);
                END IF;

                IF to_regclass('public.notification_inbox') IS NOT NULL THEN
                    INSERT INTO notification_inbox (tenant_id, principal_id, revision)
                    VALUES ({tenant}, {principal}, 1);
                END IF;
            END $notifications$;

            -- Upgrade tests also seed schemas from before the scheduler existed.
            DO $scheduling$
            BEGIN
                IF to_regclass('public.scheduled_trigger') IS NOT NULL THEN
                    INSERT INTO scheduled_trigger
                        (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id,
                         rule_id, fire_at, dedupe_key, status, lease_owner, lease_until, attempts,
                         detail, created_at, updated_at)
                    VALUES ({tenant}, gen_random_uuid(), {workspace}, {principal}, 'system',
                            'system.test', NULL, NULL, now() + interval '1 hour',
                            '{slug}-trigger-seed', 'pending', NULL, NULL, 0, NULL, now(), now());
                END IF;
            END $scheduling$;

            -- Upgrade tests also seed schemas from before automations existed. One owner-private
            -- schedule rule, one run and one per-item state row per tenant, so the isolation
            -- theories have a row of each to see and to try to relabel.
            DO $automations$
            BEGIN
                IF to_regclass('public.automation_rule') IS NOT NULL THEN
                    INSERT INTO automation_rule
                        (id, tenant_id, workspace_id, owner_principal_id, name, enabled, scope_item_id,
                         trigger_type, watch_key, trigger, conditions, actions, schema_version, revision,
                         consecutive_failures, disabled_reason, last_run_at, created_at, updated_at)
                    VALUES ({group}, {tenant}, {workspace}, {principal}, '{slug} rule', false, NULL,
                            'schedule', NULL,
                            '{automationTrigger}'::jsonb,
                            '[]'::jsonb, '{automationActions}'::jsonb, 1, 1,
                            0, NULL, NULL, now(), now());
                    INSERT INTO automation_run
                        (id, tenant_id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key,
                         origin, depth, status, detail, created_at)
                    VALUES (gen_random_uuid(), {tenant}, {group}, {principal}, {workspace}, {item},
                            '{slug}-run-seed', 'manual', 0, 'succeeded', NULL, now());
                    INSERT INTO automation_item_state
                        (tenant_id, rule_id, item_id, owner_principal_id, last_value_hash, last_fired_at)
                    VALUES ({tenant}, {group}, {item}, {principal}, NULL, now());
                END IF;
            END $automations$;

            -- Upgrade tests also seed schemas from before calendar sync existed. One owner-private
            -- connection, link, event map row and log row per tenant, so the isolation theories
            -- have a row of each to see and to try to relabel. The link is paused, so writes other
            -- tests make under the seeded item never mark it dirty.
            DO $calendar$
            BEGIN
                IF to_regclass('public.calendar_link') IS NOT NULL THEN
                    INSERT INTO calendar_connection
                        (tenant_id, id, principal_id, provider, account_subject, account_email, status,
                         refresh_token_protected, access_token_protected, access_token_expires_at, scopes,
                         last_error, created_at, updated_at)
                    VALUES ({tenant}, {acl}, {principal}, 'google', '{slug}-calendar-subject',
                            '{slug}@example.test', 'active', NULL, NULL, NULL, 'openid email', NULL, now(), now());
                    INSERT INTO calendar_link
                        (tenant_id, id, principal_id, connection_id, workspace_id, container_item_id,
                         external_calendar_id, name, direction, window_past_days, window_future_days,
                         sync_cursor, cursor_window_start, cursor_window_end, status, last_synced_at,
                         last_error, last_job_id, revision, created_at, updated_at)
                    VALUES ({tenant}, {acl}, {principal}, {acl}, {workspace}, {item}, 'primary',
                            '{slug} calendar', 'two_way', 30, 365, NULL, NULL, NULL, 'paused', NULL,
                            NULL, NULL, 1, now(), now());
                    INSERT INTO calendar_event_map
                        (tenant_id, id, link_id, principal_id, item_id, external_event_id, external_version,
                         external_updated_at, nix_version, last_synced_hash, push_nix_version, push_hash,
                         push_op, push_failures, seen_execution, deleted_at, created_at, updated_at)
                    VALUES ({tenant}, {acl}, {acl}, {principal}, {item}, '{slug}-event-seed', NULL, NULL,
                            NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, now(), now());
                    INSERT INTO calendar_sync_log
                        (tenant_id, id, link_id, principal_id, at, direction, action, item_id,
                         external_event_id, detail)
                    VALUES ({tenant}, {acl}, {acl}, {principal}, now(), 'pull', 'created', {item},
                            '{slug}-event-seed', 'seeded');
                END IF;
            END $calendar$;

            -- One published capability so the generic tenant-isolation theories exercise the
            -- public link table exactly as they do every other tenant-scoped table.
            INSERT INTO public_form_link
                (id, tenant_id, workspace_id, item_id, view_id, nonce,
                 submission_principal_id, published_by, published_at, revoked_at)
            VALUES ({auditEvent}, {tenant}, {workspace}, {item}, 'form', '{slug}-nonce',
                    {principal}, {principal}, now(), NULL);

            -- One credential the seeded principal issued, so the isolation theories exercise the
            -- token table exactly as they do every other tenant-scoped table. The hash is an
            -- arbitrary constant: no test exchanges this row, and a secret that never existed
            -- cannot leak. The lookup embeds the slug so the two tenants' rows stay unique under
            -- the global index.
            INSERT INTO personal_access_token
                (token_id, tenant_id, principal_id, name, lookup, secret_hash, scopes,
                 created_at, expires_at, revoked_at, last_used_at)
            VALUES ({group}, {tenant}, {principal}, '{slug} seeded token', 'seed{slug}0000',
                    '\\x0304'::bytea, ARRAY['read']::text[], now(), now() + interval '30 days',
                    NULL, NULL);

            -- A provisioning catalog and its operation/application mappings exercise the five
            -- template tables without adding a second item to this deliberately one-row seed.
            INSERT INTO workspace_template
                (template_id, tenant_id, workspace_id, root_item_id, pending_root_item_id,
                 stable_key, profile_key, origin, title, description, include_body,
                 include_children, managed_source, source_digest, state, revision, created_by,
                 last_modified_by, created_at, last_modified_at)
            VALUES ({template}, {tenant}, {workspace}, NULL, NULL,
                    '{slug}-template', '{slug}-template', 'user', '{slug} template', NULL,
                    false, false, NULL, NULL, 'provisioning', 1, {principal}, {principal},
                    now(), now());

            INSERT INTO template_operation
                (operation_id, tenant_id, workspace_id, template_id, kind, idempotency_key,
                 source_item_id, actor_id, draft_title, draft_description, managed_source,
                 source_digest, state, created_at, expires_at, finalized_at)
            VALUES ({templateOperation}, {tenant}, {workspace}, {template}, 'capture',
                    '{slug}-operation', {item}, {principal}, '{slug} template', NULL, NULL, NULL,
                    'provisioning', now(), now() + interval '1 hour', NULL);

            INSERT INTO template_operation_item
                (operation_id, template_source_id, tenant_id, source_item_id, target_item_id,
                 item_type, body_required)
            VALUES ({templateOperation}, {templateSource}, {tenant}, {item}, {item}, 'folder',
                    false);

            INSERT INTO template_application
                (application_id, tenant_id, workspace_id, template_id, target_item_id,
                 parent_item_id, requested_title, mode, idempotency_key, actor_id, state,
                 created_at, expires_at, finalized_at)
            VALUES ({templateApplication}, {tenant}, {workspace}, {template}, {item}, NULL, NULL,
                    'merge', '{slug}-application', {principal}, 'provisioning', now(),
                    now() + interval '1 hour', NULL);

            INSERT INTO template_application_item
                (application_id, template_source_id, tenant_id, source_item_id, item_type,
                 target_item_id, is_root, created, body_required)
            VALUES ({templateApplication}, {templateSource}, {tenant}, {item}, 'folder', {item},
                    true, false, false);

            DO $seed$
            BEGIN
                IF to_regclass('public.worker_job') IS NOT NULL THEN
                    INSERT INTO worker_job
                        (job_id, tenant_id, workspace_id, actor_id, kind, idempotency_key, payload,
                         status, attempts, cancellation_requested, created_at, updated_at)
                    VALUES ({acl}, {tenant}, {workspace}, {principal}, 'import.nix',
                            '{slug}-worker-job', jsonb_build_object('source', '{slug}'), 'queued',
                            0, false, now(), now());

                    INSERT INTO worker_outbox_event
                        (event_id, tenant_id, workspace_id, item_id, kind, aggregate_version,
                         payload, available_at, attempts)
                    VALUES ({auditEvent}, {tenant}, {workspace}, {item}, 'item.changed', 1,
                            jsonb_build_object('id', {item}, 'title', '{slug} item'), now(), 0);

                    IF to_regclass('public.plugin_publisher') IS NOT NULL THEN
                        INSERT INTO plugin_publisher
                            (tenant_id, publisher_id, ed25519_public_key, pinned_by, pinned_at)
                        VALUES ({tenant}, 'nix.seed', decode(repeat('11', 32), 'hex'),
                                {principal}, now());

                        INSERT INTO plugin_component
                            (tenant_id, publisher_id, component_id, component_version, object_key,
                             sha256, byte_length, ed25519_signature, registered_by, registered_at)
                        VALUES ({tenant}, 'nix.seed', 'nix.seed/{slug}', '1.0.0',
                                'plugins/components/{rows.TenantId:D}/nix.seed/{slug}/1.0.0/{pluginDigest}.wasm',
                                '{pluginDigest}', 8, decode(repeat('22', 64), 'hex'),
                                {principal}, now());

                        INSERT INTO plugin_installation
                            (installation_id, tenant_id, workspace_id, component_id,
                             component_version, enabled, installed_by, installed_at, updated_at)
                        VALUES ({provider}, {tenant}, {workspace}, 'nix.seed/{slug}', '1.0.0',
                                true, {principal}, now(), now());

                        INSERT INTO plugin_capability_grant
                            (tenant_id, installation_id, capability, granted_by, granted_at)
                        VALUES ({tenant}, {provider}, 'items.read-metadata', {principal}, now());

                        INSERT INTO plugin_event_receipt
                            (tenant_id, event_id, workspace_id, kind, item_id, aggregate_version,
                             causation_id, causation_depth, received_at)
                        VALUES ({tenant}, {auditEvent}, {workspace}, 'item.changed', {item}, 1,
                                {auditEvent}, 0, now());

                        INSERT INTO plugin_event_inbox
                            (tenant_id, event_id, installation_id, workspace_id, kind, item_id,
                             aggregate_version, causation_id, causation_depth, status, attempts,
                             current_invocation_id, error_code, error_detail, created_at, updated_at,
                             completed_at)
                        VALUES ({tenant}, {auditEvent}, {provider}, {workspace}, 'item.changed',
                                {item}, 1, {auditEvent}, 0, 'completed', 1, {invitation}, NULL,
                                NULL, now(), now(), now());

                        INSERT INTO plugin_invocation
                            (invocation_id, tenant_id, event_id, installation_id, workspace_id,
                             attempt, causation_id, causation_depth, status, lease_until,
                             completion_fingerprint, succeeded, retryable, error_code,
                             error_detail, created_at, completed_at)
                        VALUES ({invitation}, {tenant}, {auditEvent}, {provider}, {workspace}, 1,
                                {auditEvent}, 0, 'completed', now() + interval '1 minute',
                                decode(repeat('33', 32), 'hex'), true, false, NULL, NULL,
                                now(), now());
                    END IF;
                END IF;

                IF to_regclass('public.item_transcription') IS NOT NULL THEN
                    INSERT INTO item_transcription
                        (audio_item_id, tenant_id, workspace_id, note_item_id, job_id, speakers,
                         progress, requested_by, created_at, updated_at)
                    VALUES ({item}, {tenant}, {workspace}, {item}, {acl}, 'none', 0,
                            {principal}, now(), now());
                END IF;

                IF to_regclass('public.file_version') IS NOT NULL THEN
                    INSERT INTO file_version
                        (file_version_id, tenant_id, workspace_id, item_id, version, object_key,
                         file_name, media_type, byte_length, sha256, pixel_width, pixel_height,
                         previewable, created_by, created_at)
                    VALUES ({templateSource}, {tenant}, {workspace}, {item}, 1,
                            'files/seed/{slug}', '{slug}.bin', 'application/octet-stream', 4,
                            repeat('{(slug == "alpha" ? "a" : "b")}', 64), NULL, NULL, false,
                            {principal}, now());

                    INSERT INTO file_body
                        (item_id, tenant_id, workspace_id, current_version_id)
                    VALUES ({item}, {tenant}, {workspace}, {templateSource});

                    INSERT INTO file_upload
                        (upload_id, tenant_id, workspace_id, parent_id, target_item_id, actor_id,
                         idempotency_key, purpose, file_name, declared_media_type, declared_byte_length,
                         object_key, status, failure_code, published_item_id, expires_at, created_at,
                         updated_at)
                    VALUES ({templateApplication}, {tenant}, {workspace}, NULL, {item}, {principal},
                            '{slug}-file-upload', 'document_import', '{slug}.bin',
                            'application/octet-stream', 4,
                            'files/upload/{slug}', 'completed', NULL, {item}, now() + interval '1 hour',
                            now(), now());

                    IF to_regclass('public.template_file_transfer') IS NOT NULL THEN
                        INSERT INTO template_file_transfer
                            (transfer_id, tenant_id, workspace_id, operation_id, application_id,
                             source_item_id, target_item_id, target_version_id, source_object_key,
                             file_name, media_type, byte_length, sha256, previewable, pixel_width,
                             pixel_height, execution_id)
                        VALUES ({invitation}, {tenant}, {workspace}, {templateOperation}, NULL,
                                {item}, {item}, {templateSource}, 'files/seed/{slug}', '{slug}.bin',
                                'application/octet-stream', 4,
                                repeat('{(slug == "alpha" ? "a" : "b")}', 64), false, NULL, NULL,
                                NULL);
                    END IF;

                    IF to_regclass('public.document_import') IS NOT NULL THEN
                        INSERT INTO document_import
                            (import_id, tenant_id, workspace_id, actor_id, upload_id, parent_id,
                             format, title, idempotency_key, status, preview_job_id, commit_job_id,
                             plan_object_key, plan_sha256, plan_byte_length, source_sha256,
                             item_count, asset_count, loss, omissions, root_item_id, failure_code,
                             expires_at, created_at, updated_at, completed_at)
                        VALUES ({templateOperation}, {tenant}, {workspace}, {principal},
                                {templateApplication}, NULL, 'nix', '{slug} import',
                                '{slug}-document-import', 'completed', NULL, NULL,
                                'imports/plans/{slug}.json', repeat('c', 64), 4,
                                repeat('{(slug == "alpha" ? "a" : "b")}', 64), 1, 0,
                                '[]'::jsonb, '[]'::jsonb, {item}, NULL,
                                now() + interval '1 hour', now(), now(), now());

                        INSERT INTO document_import_item
                            (import_id, source_id, tenant_id, parent_source_id, target_item_id,
                             item_type, final_lifecycle_state, body_required, file_version_id,
                             object_key, object_ready)
                        VALUES ({templateOperation}, 'root', {tenant}, NULL, {item}, 'folder',
                                'active', false, NULL, NULL, true);

                        IF to_regclass('public.document_import_file_version') IS NOT NULL THEN
                            INSERT INTO document_import_file_version
                                (transfer_id, tenant_id, import_id, source_item_id, target_item_id,
                                 file_version_id, object_key, file_name, media_type, byte_length,
                                 sha256, previewable, pixel_width, pixel_height, object_ready,
                                 execution_id)
                            VALUES ({provider}, {tenant}, {templateOperation}, 'root', {item},
                                    {templateSource}, 'files/seed/{slug}', '{slug}.bin',
                                    'application/octet-stream', 4,
                                    repeat('{(slug == "alpha" ? "a" : "b")}', 64), false, NULL,
                                    NULL, true, NULL);
                        END IF;
                    END IF;
                END IF;
            END
            $seed$;

            """;
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}

/// <summary>
/// The identifiers of one tenant's seeded rows.
/// </summary>
/// <param name="TenantId">The tenant.</param>
/// <param name="WorkspaceId">Its workspace.</param>
/// <param name="PrincipalId">Its principal.</param>
/// <param name="GroupId">Its group.</param>
/// <param name="ProviderId">Its registered issuer.</param>
/// <param name="InvitationId">Its pending workspace invitation.</param>
/// <param name="ItemId">Its one item.</param>
/// <param name="AclEntryId">The access control entry on that item.</param>
/// <param name="AuditEventId">The audit event recording the item's creation.</param>
/// <param name="ContentDocId">The document body of that item.</param>
/// <param name="TemplateId">The tenant's template catalog row.</param>
/// <param name="TemplateOperationId">The tenant's staged template operation.</param>
/// <param name="TemplateApplicationId">The tenant's staged template application.</param>
/// <param name="TemplateSourceId">The stable source identity used by both mappings.</param>
/// <param name="Slug">A short name, used to make seeded text distinguishable in failures.</param>
internal sealed record M0TenantRows(
    Guid TenantId,
    Guid WorkspaceId,
    Guid PrincipalId,
    Guid GroupId,
    Guid ProviderId,
    Guid InvitationId,
    Guid ItemId,
    Guid AclEntryId,
    Guid AuditEventId,
    Guid ContentDocId,
    Guid TemplateId,
    Guid TemplateOperationId,
    Guid TemplateApplicationId,
    Guid TemplateSourceId,
    string Slug);
