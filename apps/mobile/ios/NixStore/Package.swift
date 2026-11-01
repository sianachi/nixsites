// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NixStore",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "NixStore", targets: ["NixStore"])],
    targets: [
        .target(name: "NixStore"),
        .testTarget(name: "NixStoreTests", dependencies: ["NixStore"])
    ]
)
