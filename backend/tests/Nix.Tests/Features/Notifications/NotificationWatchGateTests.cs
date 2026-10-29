using Nix.Features.Notifications;

namespace Nix.Tests.Features.Notifications;

public sealed class NotificationWatchGateTests
{
    [Fact]
    public void A_third_concurrent_watch_for_the_same_principal_is_refused()
    {
        var gate = new NotificationWatchGate();
        var principal = Guid.NewGuid();
        Assert.True(gate.TryEnter(principal));
        Assert.True(gate.TryEnter(principal));
        Assert.False(gate.TryEnter(principal));

        gate.Exit(principal);
        Assert.True(gate.TryEnter(principal));
    }

    [Fact]
    public void Different_principals_do_not_share_a_slot()
    {
        var gate = new NotificationWatchGate();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();
        Assert.True(gate.TryEnter(first));
        Assert.True(gate.TryEnter(first));
        Assert.True(gate.TryEnter(second));
    }

    [Fact]
    public void Exit_is_a_no_op_once_the_count_reaches_zero()
    {
        var gate = new NotificationWatchGate();
        var principal = Guid.NewGuid();
        gate.Exit(principal);
        Assert.True(gate.TryEnter(principal));
    }

    [Fact]
    public void The_process_holds_at_most_its_own_cap_across_all_principals()
    {
        var gate = new NotificationWatchGate();
        var principals = Enumerable.Range(0, NotificationWatchGate.MaxConcurrentPerProcess).Select(_ => Guid.NewGuid()).ToList();
        Assert.All(principals, principal => Assert.True(gate.TryEnter(principal)));
        var late = Guid.NewGuid();
        Assert.False(gate.TryEnter(late));

        gate.Exit(principals[0]);
        Assert.True(gate.TryEnter(late));
    }

    [Fact]
    public void An_unmatched_exit_does_not_free_a_slot()
    {
        var gate = new NotificationWatchGate();
        var principals = Enumerable.Range(0, NotificationWatchGate.MaxConcurrentPerProcess).Select(_ => Guid.NewGuid()).ToList();
        Assert.All(principals, principal => Assert.True(gate.TryEnter(principal)));
        gate.Exit(Guid.NewGuid());
        Assert.False(gate.TryEnter(Guid.NewGuid()));
    }

    [Fact]
    public void Comment_and_notification_watches_share_one_process_total_but_not_principal_slots()
    {
        var notifications = new NotificationWatchGate();
        var comments = new Nix.Features.Comments.CommentWatchGate(notifications);
        var one = Guid.NewGuid();
        Assert.True(notifications.TryEnter(one));
        Assert.True(notifications.TryEnter(one));
        Assert.True(comments.TryEnter(one));
        for (var index = 3; index < NotificationWatchGate.MaxConcurrentPerProcess; index++)
        {
            Assert.True(comments.TryEnter(Guid.NewGuid()));
        }

        Assert.False(notifications.TryEnter(Guid.NewGuid()));
        Assert.False(comments.TryEnter(Guid.NewGuid()));
        comments.Exit(one);
        Assert.True(notifications.TryEnter(Guid.NewGuid()));
    }
}
