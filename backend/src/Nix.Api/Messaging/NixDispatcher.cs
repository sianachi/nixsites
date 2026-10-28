using Microsoft.Extensions.DependencyInjection;
using Nix.Domain.Primitives;

namespace Nix.Messaging;

/// <summary>
/// Sends a command or a query to its handler.
/// </summary>
/// <remarks>
/// <para>
/// <b>Both type arguments are named at every call site, and that is the design rather than an
/// oversight.</b> C# does not infer a type argument from a constraint, so
/// <c>SendAsync&lt;CreateItem, Item&gt;(...)</c> cannot shrink to <c>SendAsync(...)</c>. The
/// shape that would infer - <c>SendAsync&lt;TResult&gt;(ICommand&lt;TResult&gt; command)</c> -
/// only knows the command's static type, so it would have to find the handler from
/// <c>command.GetType()</c> through <c>MakeGenericMethod</c>. That is reflection on a request
/// path, which this codebase already refuses for JSON (see <c>Program.cs</c>), and it trips
/// IL2060/IL3050 under warnings-as-errors. Naming the second type argument is what buys a graph
/// the compiler checks end to end.
/// </para>
/// <para>
/// <b>This is the seam for anything cross-cutting.</b> Timing, audit, and logging belong in the
/// two methods below, where every command and query passes through one place. That is the whole
/// reason a dispatcher exists rather than endpoints injecting handlers directly - there is no
/// pipeline abstraction to configure, just a method body to add a line to.
/// </para>
/// <para>
/// Resolution goes through <see cref="IServiceProvider"/> rather than through constructor-injected
/// handlers because a request touches one or two handlers out of dozens, and injecting all of them
/// would build the whole graph per request.
/// </para>
/// </remarks>
public sealed class NixDispatcher(IServiceProvider provider)
{
    /// <summary>Runs a command.</summary>
    /// <typeparam name="TCommand">The command type.</typeparam>
    /// <typeparam name="TValue">What the command produces on success.</typeparam>
    /// <param name="command">What to do.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The value produced, or why it could not be.</returns>
    /// <exception cref="InvalidOperationException">
    /// No handler is registered for <typeparamref name="TCommand"/>. Registration is explicit and
    /// unscanned, so this means a missing line in <c>AddNixPersistence</c> - which is what the
    /// composition-root test exists to catch before a request does.
    /// </exception>
    public ValueTask<Result<TValue>> SendAsync<TCommand, TValue>(
        TCommand command,
        CancellationToken cancellationToken)
        where TCommand : ICommand<TValue> =>
        provider
            .GetRequiredService<ICommandHandler<TCommand, TValue>>()
            .HandleAsync(command, cancellationToken);

    /// <summary>Answers a query.</summary>
    /// <typeparam name="TQuery">The query type.</typeparam>
    /// <typeparam name="TResult">Exactly what the query returns.</typeparam>
    /// <param name="query">What to read.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The answer.</returns>
    /// <exception cref="InvalidOperationException">
    /// No handler is registered for <typeparamref name="TQuery"/>.
    /// </exception>
    public ValueTask<TResult> QueryAsync<TQuery, TResult>(
        TQuery query,
        CancellationToken cancellationToken)
        where TQuery : IQuery<TResult> =>
        provider
            .GetRequiredService<IQueryHandler<TQuery, TResult>>()
            .HandleAsync(query, cancellationToken);
}
