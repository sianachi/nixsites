# syntax=docker/dockerfile:1
# Two images, one build: Core and the migration job share the same compilation.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore against the manifests first so a source-only change does not re-resolve NuGet.
COPY Nix.slnx ./
COPY backend/Directory.Build.props backend/Directory.Packages.props backend/
COPY backend/src/Nix.Api/Nix.Api.csproj backend/src/Nix.Api/
COPY backend/src/Nix.Migrator/Nix.Migrator.csproj backend/src/Nix.Migrator/
RUN dotnet restore backend/src/Nix.Api/Nix.Api.csproj \
 && dotnet restore backend/src/Nix.Migrator/Nix.Migrator.csproj

# The local embedding model (about 35 MB) is fetched in its own cached layer, ahead of the source.
COPY scripts/fetch-embedding-model.sh scripts/
RUN sh scripts/fetch-embedding-model.sh backend/models/bge-small-en-v1.5

COPY backend/ backend/
# The build regenerates backend/openapi/nix-api.json as a side effect (see Nix.Api.csproj).
# That is harmless here; the committed contract is what CI verifies, not this copy.
RUN dotnet publish backend/src/Nix.Api/Nix.Api.csproj \
      -c Release --no-restore -o /out/api \
 && dotnet publish backend/src/Nix.Migrator/Nix.Migrator.csproj \
      -c Release --no-restore -o /out/migrator

# InvariantGlobalization is false in backend/Directory.Build.props, so the runtime needs ICU.
# The "-extra" chiseled variant carries it; plain "-chiseled" does not and the process will
# fail at startup. If in doubt, fall back to mcr.microsoft.com/dotnet/aspnet:10.0.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra AS api
WORKDIR /app
COPY --from=build /out/api ./
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_gcServer=0
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "Nix.Api.dll"]

# The migrator references the API persistence assembly, which carries the ASP.NET shared
# framework; use the same runtime family as Core so the migration job can start on ARM hosts.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled-extra AS migrator
WORKDIR /app
COPY --from=build /out/migrator ./
USER $APP_UID
ENTRYPOINT ["dotnet", "Nix.Migrator.dll"]
