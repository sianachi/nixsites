using Nix.Workers.Queue;

namespace Nix.Tests.Workers;

public sealed class InProcessJobQueueTests
{
    [Fact]
    public void Every_kind_belongs_to_exactly_one_family_and_site_jobs_to_none()
    {
        var kinds = JobFamilies.All.SelectMany(JobFamilies.KindsOf).ToArray();

        Assert.Equal(kinds.Length, kinds.Distinct(StringComparer.Ordinal).Count());
        Assert.All(kinds, kind => Assert.NotNull(JobFamilies.Of(kind)));
        Assert.Equal(JobFamilies.Import, JobFamilies.Of("object.cleanup"));
        Assert.Equal(JobFamilies.Import, JobFamilies.Of("template.files.copy"));
        Assert.Null(JobFamilies.Of("site.build"));
    }

    [Fact]
    public void A_hint_wakes_the_hosted_family_once_and_is_refused_for_the_rest()
    {
        var queue = new InProcessJobQueue(new HashSet<string>(StringComparer.Ordinal) { JobFamilies.Notify });

        Assert.True(queue.Hint("notify.push"));
        Assert.True(queue.Hint("notify.push"));
        Assert.False(queue.Hint("export.pdf"));
        Assert.False(queue.Hint("site.build"));

        // Two hints, one pending item: a hint is a hint, not a count.
        Assert.True(queue.Reader(JobFamilies.Notify).TryRead(out _));
        Assert.False(queue.Reader(JobFamilies.Notify).TryRead(out _));
        Assert.False(queue.Reader(JobFamilies.Export).TryRead(out _));
    }
}
