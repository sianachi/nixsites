using System.IO.Compression;
using UglyToad.PdfPig.Filters;
using UglyToad.PdfPig.Tokens;

namespace Nix.Workers.Import;

/// <summary>
/// PdfPig's stream filters with a decoded-byte budget for one document: a Flate stream is counted
/// before it is inflated into memory, LZW and RunLength (unbounded expansion, rare in text PDFs)
/// are refused, and every decoded stream draws on the budget. Without it a 1 MB upload of
/// compressed zeros inflates to gigabytes inside Core.
/// </summary>
internal sealed class BoundedPdfFilters(long budget) : IFilterProvider
{
    private long remaining = budget;

    public IReadOnlyList<IFilter> GetFilters(DictionaryToken dictionary) => Wrap(DefaultFilterProvider.Instance.GetFilters(dictionary));

    public IReadOnlyList<IFilter> GetNamedFilters(IReadOnlyList<NameToken> names) => Wrap(DefaultFilterProvider.Instance.GetNamedFilters(names));

    public IReadOnlyList<IFilter> GetAllFilters() => Wrap(DefaultFilterProvider.Instance.GetAllFilters());

    private IFilter[] Wrap(IReadOnlyList<IFilter> filters) => [.. filters.Select(filter => (IFilter)new Bounded(filter, this))];

    private void Spend(long bytes)
    {
        if (Interlocked.Add(ref remaining, -bytes) < 0)
        {
            throw new ImportPlanException("PDF streams expand beyond the configured limit");
        }
    }

    private sealed class Bounded(IFilter inner, BoundedPdfFilters owner) : IFilter
    {
        public bool IsSupported => inner.IsSupported;

        public Memory<byte> Decode(Memory<byte> input, DictionaryToken streamDictionary, IFilterProvider filterProvider, int filterIndex)
        {
            if (inner is LzwFilter or RunLengthFilter)
            {
                throw new ImportPlanException("PDF uses an unsupported stream compression");
            }
            if (inner is FlateFilter)
            {
                CountInflated(input, Interlocked.Read(ref owner.remaining));
            }
            var output = inner.Decode(input, streamDictionary, filterProvider, filterIndex);
            owner.Spend(output.Length);
            return output;
        }

        // Inflates into nothing, failing as soon as the output passes what the budget has left.
        private static void CountInflated(Memory<byte> input, long limit)
        {
            if (input.Length < 2)
            {
                return;
            }
            using var source = new MemoryStream(input[2..].ToArray(), writable: false);
            using var inflate = new DeflateStream(source, CompressionMode.Decompress);
            var buffer = new byte[64 * 1024]; // byte[]: a discard buffer for counting
            long total = 0;
            try
            {
                int read;
                while ((read = inflate.Read(buffer)) > 0)
                {
                    total += read;
                    if (total > limit)
                    {
                        throw new ImportPlanException("PDF streams expand beyond the configured limit");
                    }
                }
            }
            catch (InvalidDataException)
            {
                // A corrupt stream is the inner filter's to report; what was counted fit the budget.
            }
        }
    }
}
