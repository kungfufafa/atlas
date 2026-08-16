export interface DerivedAsset {
  artifactId: string;
  bytes: Buffer;
  contentHash: string;
  converterVersion: string;
  createdAt: string;
  expiresAt: number;
  mimeType: "application/pdf";
  orgId: string;
  pageCount: number;
  profileId: string;
  revision: number;
}

export class DerivedAssetStore {
  private readonly assets = new Map<string, DerivedAsset>();
  private readonly defaultTtlMs = 30 * 60 * 1000; // 30 minutes

  buildKey(
    orgId: string,
    profileId: string,
    artifactId: string,
    revision: number,
    contentHash: string,
    converterVersion: string
  ): string {
    const safeTarget = artifactId.replace(/[/\\]/g, "_");
    return `${orgId}:${profileId}:${safeTarget}:r${revision}:${contentHash}:${converterVersion}`;
  }

  storeDerivedAsset(
    input: Omit<DerivedAsset, "createdAt" | "expiresAt"> & { ttlMs?: number }
  ): DerivedAsset {
    const key = this.buildKey(
      input.orgId,
      input.profileId,
      input.artifactId,
      input.revision,
      input.contentHash,
      input.converterVersion
    );

    const asset: DerivedAsset = {
      artifactId: input.artifactId,
      bytes: input.bytes,
      contentHash: input.contentHash,
      converterVersion: input.converterVersion,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + (input.ttlMs ?? this.defaultTtlMs),
      mimeType: input.mimeType,
      orgId: input.orgId,
      pageCount: input.pageCount,
      profileId: input.profileId,
      revision: input.revision,
    };

    this.assets.set(key, asset);
    return asset;
  }

  getDerivedAsset(
    orgId: string,
    profileId: string,
    artifactId: string,
    revision: number,
    contentHash: string,
    converterVersion: string
  ): DerivedAsset | undefined {
    const key = this.buildKey(
      orgId,
      profileId,
      artifactId,
      revision,
      contentHash,
      converterVersion
    );
    const asset = this.assets.get(key);
    if (!asset) {
      return;
    }

    // Check expiration
    if (asset.expiresAt < Date.now()) {
      this.assets.delete(key);
      return;
    }

    // Strict multi-tenant verification
    if (asset.orgId !== orgId || asset.profileId !== profileId) {
      return;
    }

    return asset;
  }

  invalidate(orgId: string, profileId: string, pathPrefix?: string): void {
    const prefix = `${orgId}:${profileId}:`;
    for (const [key, asset] of this.assets.entries()) {
      if (
        key.startsWith(prefix) &&
        (!pathPrefix || asset.artifactId.includes(pathPrefix))
      ) {
        this.assets.delete(key);
      }
    }
  }

  clear(): void {
    this.assets.clear();
  }
}

export const derivedAssetStore = new DerivedAssetStore();
