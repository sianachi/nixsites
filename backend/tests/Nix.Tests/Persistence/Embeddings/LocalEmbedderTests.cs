using Nix.Persistence.Embeddings;

namespace Nix.Tests.Persistence.Embeddings;

/// <summary>The local model loads, embeds to unit vectors, and ranks a paraphrase above an unrelated sentence.</summary>
public sealed class LocalEmbedderTests
{
    [Fact]
    public void A_paraphrase_scores_closer_than_an_unrelated_sentence()
    {
        using var embedder = new LocalEmbedder(LocalEmbedder.DefaultDirectory);
        Assert.SkipUnless(embedder.Available, "The local embedding model is not fetched (scripts/fetch-embedding-model.sh).");

        var query = embedder.EmbedQuery("How much notice is needed to cancel the contract?")!;
        var passages = embedder.Embed(
        [
            "Either party may terminate the agreement with thirty days written warning.",
            "The office plants are watered every Tuesday morning.",
        ])!;

        Assert.Equal(LocalEmbedder.Dimensions, query.Length);
        Assert.Equal(1.0, Math.Sqrt(query.Sum(value => (double)value * value)), 3);
        Assert.True(Dot(query, passages[0]) > Dot(query, passages[1]) + 0.1);
    }

    [Fact]
    public async Task The_model_loads_on_first_use_and_is_released_after_sitting_idle()
    {
        using var embedder = new LocalEmbedder(LocalEmbedder.DefaultDirectory, idleRelease: TimeSpan.FromMilliseconds(150));
        Assert.SkipUnless(embedder.Installed, "The local embedding model is not fetched (scripts/fetch-embedding-model.sh).");

        // Knowing the files are there loads nothing.
        Assert.False(embedder.Loaded);

        var first = embedder.EmbedQuery("How much notice is needed to cancel the contract?")!;
        Assert.True(embedder.Loaded);

        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (embedder.Loaded && DateTime.UtcNow < deadline)
        {
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
        Assert.False(embedder.Loaded);

        // The next use loads it again and answers the same.
        var again = embedder.EmbedQuery("How much notice is needed to cancel the contract?")!;
        Assert.True(embedder.Loaded);
        Assert.Equal(first, again);
    }

    [Fact]
    public void A_missing_model_is_unavailable_rather_than_an_error()
    {
        using var embedder = new LocalEmbedder(Path.Combine(Path.GetTempPath(), "no-such-model"));

        Assert.False(embedder.Installed);
        Assert.False(embedder.Available);
        Assert.Null(embedder.EmbedQuery("anything"));
    }

    private static double Dot(float[] left, float[] right) =>
        left.Zip(right, (a, b) => (double)a * b).Sum();
}
