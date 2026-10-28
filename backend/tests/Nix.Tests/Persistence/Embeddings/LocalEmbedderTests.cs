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
    public void A_missing_model_is_unavailable_rather_than_an_error()
    {
        using var embedder = new LocalEmbedder(Path.Combine(Path.GetTempPath(), "no-such-model"));

        Assert.False(embedder.Available);
        Assert.Null(embedder.EmbedQuery("anything"));
    }

    private static double Dot(float[] left, float[] right) =>
        left.Zip(right, (a, b) => (double)a * b).Sum();
}
