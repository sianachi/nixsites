using Microsoft.EntityFrameworkCore;
using Nix.Persistence;

namespace Nix.Tests.Persistence;

public sealed class ModelSnapshotTests
{
    // Some migrations are hand-written (no EF tooling), so nothing else compares the snapshot to the model.
    [Fact]
    public void The_model_snapshot_matches_the_model()
    {
        var options = new DbContextOptionsBuilder<NixDbContext>()
            .UseNpgsql("Host=unused;Database=unused")
            .Options;
        using var context = new NixDbContext(options);

        Assert.False(context.Database.HasPendingModelChanges());
    }
}
