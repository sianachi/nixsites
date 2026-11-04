using System.Net;
using System.Net.Sockets;
using System.Text;
using Nix.Workers.Export;

namespace Nix.Tests.Workers;

/// <summary>A diagram SVG is user content rendered inside Core: it may not reach the network or size the canvas.</summary>
public sealed class DiagramsTests
{
    [Fact]
    public void Referenced_images_and_elements_are_never_fetched()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var target = $"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}";
        var svg = $"""
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20">
              <image href="{target}/a.png" width="10" height="10"/>
              <image xlink:href="{target}/b.png" width="10" height="10"/>
              <use href="{target}/c.svg#x"/>
              <rect width="5" height="5" fill="red"/>
            </svg>
            """;

        var (png, width) = Diagrams.Rasterize(Encoding.UTF8.GetBytes(svg));

        Assert.NotEmpty(png);
        Assert.Equal(20, width);
        Assert.False(listener.Pending());
    }

    [Fact]
    public void A_drawing_without_a_usable_declared_size_cannot_size_a_huge_canvas()
    {
        const string svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60000 60000"><rect width="60000" height="60000" fill="red"/></svg>""";

        Assert.Throws<InvalidDataException>(() => Diagrams.Rasterize(Encoding.UTF8.GetBytes(svg)));
    }
}
