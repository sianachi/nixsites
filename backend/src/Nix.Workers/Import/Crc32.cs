namespace Nix.Workers.Import;

/// <summary>CRC-32 (IEEE), as PNG chunks and ZIP members carry it.</summary>
internal static class Crc32
{
    private static readonly uint[] Table = Build();

    public static uint Compute(ReadOnlySpan<byte> body) => Append(0, body);

    public static uint Append(uint crc, ReadOnlySpan<byte> body)
    {
        crc = ~crc;
        foreach (var value in body)
        {
            crc = Table[(crc ^ value) & 0xff] ^ (crc >> 8);
        }
        return ~crc;
    }

    private static uint[] Build()
    {
        var table = new uint[256];
        for (uint index = 0; index < 256; index++)
        {
            var value = index;
            for (var bit = 0; bit < 8; bit++)
            {
                value = (value & 1) != 0 ? 0xEDB88320 ^ (value >> 1) : value >> 1;
            }
            table[index] = value;
        }
        return table;
    }
}
