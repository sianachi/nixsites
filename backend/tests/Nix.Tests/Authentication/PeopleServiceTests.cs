using System.Reflection;
using Nix.Abstractions;
using Nix.Domain.Audit;
using Nix.Domain.Identity;
using Nix.Domain.Tenancy;
using Nix.Features.People;

namespace Nix.Tests.Authentication;

/// <summary>The People admin guards: administrators only, no self-disable, never the last administrator, no cross-tenant reach.</summary>
public sealed class PeopleServiceTests
{
    private static readonly TenantId Tenant = TenantId.From(Guid.NewGuid());
    private static readonly TenantId OtherTenant = TenantId.From(Guid.NewGuid());
    private static readonly PrincipalId Admin = PrincipalId.From(Guid.NewGuid());
    private static readonly PrincipalId Member = PrincipalId.From(Guid.NewGuid());

    [Theory]
    [InlineData(true, true, PeopleRefusal.SelfDisable)]
    [InlineData(true, false, PeopleRefusal.SelfDisable)]
    [InlineData(false, false, PeopleRefusal.LastAdministrator)]
    [InlineData(false, true, PeopleRefusal.None)]
    public void Disable_rules(bool self, bool anotherAdmin, PeopleRefusal expected)
    {
        var target = self ? Admin.Value : Member.Value;
        Assert.Equal(expected, PeopleRules.CheckDisable(Admin.Value, target, anotherAdmin));
    }

    [Fact]
    public async Task A_non_administrator_is_refused_before_anything_is_read_or_changed()
    {
        var harness = new Harness(isAdmin: false);

        Assert.Equal(PeopleRefusal.NotAdministrator, (await harness.Service.ListAsync(CancellationToken.None)).Refusal);
        Assert.Equal(PeopleRefusal.NotAdministrator, await harness.Service.SetDisabledAsync(Member.Value, true, CancellationToken.None));
        Assert.Equal(PeopleRefusal.NotAdministrator, (await harness.Service.ResetLinkAsync(Member.Value, CancellationToken.None)).Refusal);
        Assert.Equal(PeopleRefusal.NotAdministrator, (await harness.Service.AddAsync("a@b.co", "A", CancellationToken.None)).Refusal);
        Assert.Empty(harness.Disabled);
        Assert.Empty(harness.Audit);
    }

    [Fact]
    public async Task An_administrator_cannot_issue_a_reset_link_for_themselves()
    {
        var harness = new Harness();

        Assert.Equal(PeopleRefusal.SelfReset, (await harness.Service.ResetLinkAsync(Admin.Value, CancellationToken.None)).Refusal);
    }

    [Fact]
    public async Task An_administrator_cannot_disable_themselves()
    {
        var harness = new Harness();

        Assert.Equal(PeopleRefusal.SelfDisable, await harness.Service.SetDisabledAsync(Admin.Value, true, CancellationToken.None));
        Assert.Empty(harness.Disabled);
    }

    [Fact]
    public async Task The_last_active_administrator_cannot_be_disabled()
    {
        var harness = new Harness(anotherAdmin: false);

        Assert.Equal(PeopleRefusal.LastAdministrator, await harness.Service.SetDisabledAsync(Member.Value, true, CancellationToken.None));
        Assert.Empty(harness.Disabled);
    }

    [Fact]
    public async Task Disabling_is_stored_and_audited_and_enabling_needs_no_administrator_left_behind()
    {
        var harness = new Harness();

        Assert.Equal(PeopleRefusal.None, await harness.Service.SetDisabledAsync(Member.Value, true, CancellationToken.None));
        Assert.Equal(PeopleRefusal.None, await harness.Service.SetDisabledAsync(Member.Value, false, CancellationToken.None));

        Assert.Equal([true, false], harness.Disabled);
        Assert.Equal(["tenant.person_disabled", "tenant.person_enabled"], harness.Audit);
    }

    [Fact]
    public async Task A_person_of_another_tenant_or_without_a_local_account_is_not_found()
    {
        var foreign = new Harness(memberTenant: OtherTenant);
        var missing = new Harness(memberExists: false);

        Assert.Equal(PeopleRefusal.NotFound, await foreign.Service.SetDisabledAsync(Member.Value, true, CancellationToken.None));
        Assert.Equal(PeopleRefusal.NotFound, (await foreign.Service.ResetLinkAsync(Member.Value, CancellationToken.None)).Refusal);
        Assert.Equal(PeopleRefusal.NotFound, await missing.Service.SetDisabledAsync(Member.Value, true, CancellationToken.None));
        Assert.Empty(foreign.Disabled);
    }

    [Theory]
    [InlineData("not an email", "Ada", PeopleRefusal.EmailInvalid)]
    [InlineData("ada@example.com", "  ", PeopleRefusal.NameInvalid)]
    public async Task A_new_person_needs_a_usable_email_and_name(string email, string name, PeopleRefusal expected) =>
        Assert.Equal(expected, (await new Harness().Service.AddAsync(email, name, CancellationToken.None)).Refusal);

    private sealed class Harness
    {
        private readonly List<string> _audit = [];
        private readonly List<bool> _disabled = [];

        internal Harness(bool isAdmin = true, bool anotherAdmin = true, TenantId? memberTenant = null, bool memberExists = true)
        {
            var record = new LocalAccountRecord(Member, memberTenant ?? Tenant, "m@example.com", "M", PrincipalStatus.Active, null, null, null, false, 0, 0);
            Service = new PeopleService(
                Stub<IPeopleStore>.Create((method, args) => method switch
                {
                    nameof(IPeopleStore.SetDisabledAsync) => Record(args),
                    _ => throw new NotSupportedException(method),
                }),
                Stub<IPermissionResolver>.Create((method, _) => method == nameof(IPermissionResolver.IsTenantAdministratorAsync)
                    ? isAdmin
                    : throw new NotSupportedException(method)),
                Stub<IAccessGrantStore>.Create((method, args) =>
                {
                    switch (method)
                    {
                        case nameof(IAccessGrantStore.AnyOtherTenantAdminAsync):
                            return anotherAdmin;
                        case nameof(IAccessGrantStore.AddAudit):
                            _audit.Add(((AuditEvent)args[0]!).Action);
                            return null;
                        case nameof(IAccessGrantStore.SaveAsync):
                            return null;
                        default:
                            throw new NotSupportedException(method);
                    }
                }),
                new Session(),
                Stub<ILocalAccounts>.Create((method, _) => method == nameof(ILocalAccounts.FindByPrincipalAsync)
                    ? (memberExists ? record : null)
                    : throw new NotSupportedException(method)),
                null!,
                null!,
                TimeProvider.System);
        }

        internal PeopleService Service { get; }

        internal IReadOnlyList<bool> Disabled => _disabled;

        internal IReadOnlyList<string> Audit => _audit;

        private bool Record(object?[] args)
        {
            _disabled.Add((bool)args[2]!);
            return true;
        }
    }

    private sealed class Session : INixSessionContextAccessor
    {
        public NixSessionContext? Current { get; } = NixSessionContext.ForTenant(Tenant, Admin);
    }
}

/// <summary>An interface double whose every member goes to one handler returning the plain result; an unknown member fails loudly.</summary>
public class Stub<T> : DispatchProxy
    where T : class
{
    private Func<string, object?[], object?> _handler = static (name, _) => throw new NotSupportedException(name);

    internal static T Create(Func<string, object?[], object?> handler)
    {
        var proxy = Create<T, Stub<T>>();
        ((Stub<T>)(object)proxy)._handler = handler;
        return proxy;
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        ArgumentNullException.ThrowIfNull(targetMethod);
        var result = _handler(targetMethod.Name, args ?? []);
        var type = targetMethod.ReturnType;
        return type == typeof(ValueTask) ? default(ValueTask)
            : type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ValueTask<>) ? type.GetConstructor([type.GetGenericArguments()[0]])!.Invoke([result])
            : result;
    }
}
