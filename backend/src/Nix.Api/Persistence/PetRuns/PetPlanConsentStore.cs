using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.PetRuns;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.PetRuns;

/// <inheritdoc />
public sealed class PetPlanConsentStore(NixDbContext database, INixSessionContextAccessor session) : IPetPlanConsentStore
{
    private NixSessionContext Caller => session.Current ?? throw new InvalidOperationException("A tenant transaction is required.");

    public async Task<PetPlanConsentRecord?> FindAsync(WorkspaceId workspaceId, Guid petId, string scopeDigest,
        string recipientRevision, CancellationToken cancellationToken)
    {
        var caller = Caller;
        var row = await database.Database.SqlQuery<ConsentRow>($"""
            SELECT id AS "Id", workspace_id AS "WorkspaceId", pet_id AS "PetId", scope_digest AS "ScopeDigest",
                   recipient_revision AS "RecipientRevision", request_id AS "RequestId", authority_id AS "AuthorityId",
                   granted_at AS "GrantedAt", expires_at AS "ExpiresAt", revoked_at AS "RevokedAt"
              FROM pet_plan_consent
             WHERE tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
               AND workspace_id = {workspaceId.Value} AND pet_id = {petId}
               AND scope_digest = {scopeDigest} AND recipient_revision = {recipientRevision}
               AND request_id <> {Guid.Empty}
            """).SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return row is null ? null : new(row.Id, WorkspaceId.From(row.WorkspaceId), row.PetId, row.ScopeDigest,
            row.RecipientRevision, row.RequestId, row.AuthorityId, row.GrantedAt, row.ExpiresAt, row.RevokedAt);
    }

    public async Task<PetPlanConsentQuestion> PrepareQuestionAsync(WorkspaceId workspaceId, Guid petId,
        string scopeDigest, string recipientRevision, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var caller = Caller;
        RequireOwnerScope(caller);
        await HoldOwnerAsync(cancellationToken).ConfigureAwait(false);
        var questions = await database.Database.SqlQuery<QuestionRow>($"""
            INSERT INTO pet_plan_consent (id, tenant_id, owner_id, workspace_id, pet_id, scope_digest,
                recipient_revision, request_id, authority_id, granted_at, expires_at, revoked_at,
                decision_nonce, question_expires_at, updated_at)
            VALUES ({Guid.NewGuid()}, {caller.TenantId.Value}, {caller.PrincipalId.Value}, {workspaceId.Value},
                {petId}, {scopeDigest}, {recipientRevision}, {Guid.Empty}, {Guid.Empty}, {now}, {now.AddDays(30)}, {now},
                {Guid.NewGuid()}, {now.AddMinutes(30)}, {now})
            ON CONFLICT (tenant_id, owner_id, workspace_id, pet_id, scope_digest, recipient_revision)
            DO UPDATE SET
                decision_nonce = CASE WHEN pet_plan_consent.decision_nonce IS NOT NULL AND pet_plan_consent.question_expires_at > {now}
                    THEN pet_plan_consent.decision_nonce ELSE EXCLUDED.decision_nonce END,
                question_expires_at = CASE WHEN pet_plan_consent.decision_nonce IS NOT NULL AND pet_plan_consent.question_expires_at > {now}
                    THEN pet_plan_consent.question_expires_at ELSE EXCLUDED.question_expires_at END,
                updated_at = CASE WHEN pet_plan_consent.decision_nonce IS NOT NULL AND pet_plan_consent.question_expires_at > {now}
                    THEN pet_plan_consent.updated_at ELSE EXCLUDED.updated_at END
            RETURNING id AS "Id", decision_nonce AS "DecisionNonce", question_expires_at AS "ExpiresAt"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        var question = questions.Single();
        await CleanupConsentsAsync(question.Id, cancellationToken).ConfigureAwait(false);
        return new(question.Id, question.DecisionNonce, question.ExpiresAt);
    }

    public async Task<bool> DecideAsync(PetPlanConsentRecord consent, Guid decisionNonce, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(consent);
        var caller = Caller;
        if (decisionNonce == Guid.Empty || consent.RequestId == Guid.Empty || consent.AuthorityId == Guid.Empty
            || consent.ExpiresAt <= consent.GrantedAt || consent.ExpiresAt > consent.GrantedAt.AddDays(30))
        {
            return false;
        }
        await HoldOwnerAsync(cancellationToken).ConfigureAwait(false);

        var consumed = await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_plan_consent
               SET request_id = {consent.RequestId}, authority_id = {consent.AuthorityId},
                   granted_at = {consent.GrantedAt}, expires_at = {consent.ExpiresAt}, revoked_at = {consent.RevokedAt},
                   last_decision_nonce = decision_nonce, decision_nonce = NULL, question_expires_at = NULL,
                   updated_at = {consent.GrantedAt}
             WHERE tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
               AND workspace_id = {consent.WorkspaceId.Value} AND pet_id = {consent.PetId}
               AND scope_digest = {consent.ScopeDigest} AND recipient_revision = {consent.RecipientRevision}
               AND decision_nonce = {decisionNonce} AND question_expires_at > {consent.GrantedAt}
               AND request_id <> {consent.RequestId}
            """, cancellationToken).ConfigureAwait(false);
        if (consumed == 1)
        {
            return true;
        }
        return await database.Database.SqlQuery<int>($"""
            SELECT 1 AS "Value" FROM pet_plan_consent
             WHERE tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
               AND workspace_id = {consent.WorkspaceId.Value} AND pet_id = {consent.PetId}
               AND scope_digest = {consent.ScopeDigest} AND recipient_revision = {consent.RecipientRevision}
               AND last_decision_nonce = {decisionNonce} AND request_id = {consent.RequestId}
               AND (revoked_at IS NULL) = {consent.RevokedAt is null}
            """).AnyAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> CreateContextAsync(PetPlanDecisionContextRecord context, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        var caller = Caller;
        RequireOwnerScope(caller);
        await HoldOwnerAsync(cancellationToken).ConfigureAwait(false);
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO pet_plan_decision_context (id, tenant_id, owner_id, workspace_id, run_id, plan_id, plan_version,
                review_digest, grantee_credential_id, client_name, approve, secret_hash, expires_at)
            SELECT {context.Id}, {caller.TenantId.Value}, {caller.PrincipalId.Value}, {context.WorkspaceId.Value},
                {context.RunId}, {context.PlanId}, {context.PlanVersion}, {context.ReviewDigest},
                {context.GranteeCredentialId}, {context.ClientName}, {context.Approve}, {context.SecretHash}, {context.ExpiresAt}
            WHERE EXISTS (SELECT 1 FROM pet_run WHERE id = {context.RunId} AND tenant_id = {caller.TenantId.Value}
                AND actor_id = {caller.PrincipalId.Value} AND workspace_id = {context.WorkspaceId.Value})
            ON CONFLICT (id) DO NOTHING
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<PetPlanDecisionContextRecord?> ReadContextAsync(Guid contextId, CancellationToken cancellationToken)
    {
        var caller = Caller;
        var row = await database.Database.SqlQuery<ContextRow>($"""
            SELECT id AS "Id", workspace_id AS "WorkspaceId", run_id AS "RunId", plan_id AS "PlanId",
                plan_version AS "PlanVersion", review_digest AS "ReviewDigest", grantee_credential_id AS "GranteeCredentialId",
                client_name AS "ClientName", approve AS "Approve", secret_hash AS "SecretHash", expires_at AS "ExpiresAt",
                authority_id AS "AuthorityId", authorized_at AS "AuthorizedAt", revoked_at AS "RevokedAt",
                consumed_request_id AS "ConsumedRequestId", consumed_at AS "ConsumedAt"
            FROM pet_plan_decision_context
            WHERE id = {contextId} AND tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
            """).SingleOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        return row is null ? null : new(row.Id, WorkspaceId.From(row.WorkspaceId), row.RunId, row.PlanId,
            row.PlanVersion, row.ReviewDigest, row.GranteeCredentialId, row.ClientName, row.Approve, row.SecretHash,
            row.ExpiresAt, row.AuthorityId, row.AuthorizedAt, row.RevokedAt, row.ConsumedRequestId, row.ConsumedAt);
    }

    public async Task<bool> AuthorizeContextAsync(PetPlanDecisionContextRecord context, Guid authorityId,
        DateTimeOffset now, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        var caller = Caller;
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_plan_decision_context SET authority_id = {authorityId}, authorized_at = {now}
            WHERE id = {context.Id} AND tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
                AND workspace_id = {context.WorkspaceId.Value} AND run_id = {context.RunId} AND plan_id = {context.PlanId}
                AND plan_version = {context.PlanVersion} AND review_digest = {context.ReviewDigest}
                AND grantee_credential_id = {context.GranteeCredentialId} AND approve = {context.Approve}
                AND client_name = {context.ClientName} AND expires_at > {now}
                AND revoked_at IS NULL AND consumed_request_id IS NULL AND authority_id IS NULL
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task<PetPlanDecisionContextRecord?> ConsumeContextAsync(string secretHash, WorkspaceId workspaceId,
        Guid runId, Guid planId, int planVersion, string reviewDigest, bool approve, Guid granteeCredentialId,
        Guid requestId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var caller = Caller;
        var ids = await database.Database.SqlQuery<Guid>($"""
            UPDATE pet_plan_decision_context SET consumed_request_id = {requestId}, consumed_at = COALESCE(consumed_at, {now})
            WHERE tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
                AND secret_hash = {secretHash} AND workspace_id = {workspaceId.Value} AND run_id = {runId}
                AND plan_id = {planId} AND plan_version = {planVersion} AND review_digest = {reviewDigest}
                AND approve = {approve} AND grantee_credential_id = {granteeCredentialId}
                AND expires_at > {now} AND revoked_at IS NULL AND authority_id IS NOT NULL
                AND (consumed_request_id IS NULL OR consumed_request_id = {requestId})
            RETURNING id AS "Value"
            """).ToListAsync(cancellationToken).ConfigureAwait(false);
        return ids.Count == 1 ? await ReadContextAsync(ids[0], cancellationToken).ConfigureAwait(false) : null;
    }

    public async Task<bool> RevokeContextAsync(Guid contextId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var caller = Caller;
        return await database.Database.ExecuteSqlInterpolatedAsync($"""
            UPDATE pet_plan_decision_context SET revoked_at = COALESCE(revoked_at, {now})
            WHERE id = {contextId} AND tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
                AND consumed_request_id IS NULL
            """, cancellationToken).ConfigureAwait(false) == 1;
    }

    public async Task CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var caller = Caller;
        await HoldOwnerAsync(cancellationToken).ConfigureAwait(false);
        await CleanupConsentsAsync(null, cancellationToken).ConfigureAwait(false);
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM pet_plan_decision_context WHERE id IN (
                SELECT id FROM pet_plan_decision_context WHERE tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
                ORDER BY expires_at DESC, id OFFSET 100 LIMIT 100);
            """, cancellationToken).ConfigureAwait(false);
    }

    private Task<int> CleanupConsentsAsync(Guid? retainedId, CancellationToken cancellationToken)
    {
        var caller = Caller;
        return database.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM pet_plan_consent WHERE id IN (
                SELECT id FROM pet_plan_consent WHERE tenant_id = {caller.TenantId.Value} AND owner_id = {caller.PrincipalId.Value}
                ORDER BY (id IS NOT DISTINCT FROM {retainedId}) DESC, updated_at DESC, id
                OFFSET 100 LIMIT 100)
            """, cancellationToken);
    }

    private async Task HoldOwnerAsync(CancellationToken cancellationToken)
    {
        var caller = Caller;
        await database.Database.ExecuteSqlInterpolatedAsync($"""
            SELECT pg_advisory_xact_lock(hashtextextended(
                'pet-plan-consent:' || {caller.TenantId.Value}::text || ':' || {caller.PrincipalId.Value}::text, 0))
            """, cancellationToken).ConfigureAwait(false);
    }

    private static void RequireOwnerScope(NixSessionContext caller)
    {
        if (caller.WorkspaceId is not null)
        {
            throw new InvalidOperationException("Pending sharing questions and handoffs require an owner-wide transaction.");
        }
    }

    [SuppressMessage("Performance", "CA1812", Justification = "EF materializes SQL rows.")]
    private sealed record ConsentRow(Guid Id, Guid WorkspaceId, Guid PetId, string ScopeDigest, string RecipientRevision,
        Guid RequestId, Guid AuthorityId, DateTimeOffset GrantedAt, DateTimeOffset ExpiresAt, DateTimeOffset? RevokedAt);
    [SuppressMessage("Performance", "CA1812", Justification = "EF materializes SQL rows.")]
    private sealed record QuestionRow(Guid Id, Guid DecisionNonce, DateTimeOffset ExpiresAt);
    [SuppressMessage("Performance", "CA1812", Justification = "EF materializes SQL rows.")]
    private sealed record ContextRow(Guid Id, Guid WorkspaceId, Guid RunId, Guid PlanId, int PlanVersion, string ReviewDigest,
        Guid GranteeCredentialId, string ClientName, bool Approve, string SecretHash, DateTimeOffset ExpiresAt,
        Guid? AuthorityId, DateTimeOffset? AuthorizedAt, DateTimeOffset? RevokedAt, Guid? ConsumedRequestId, DateTimeOffset? ConsumedAt);
}
