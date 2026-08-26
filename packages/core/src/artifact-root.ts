import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { AtlasApiError } from "./api-error";
import { getProfileArtifactsDir, getProfileSoulDir } from "./soul/resolve";

function sameFile(left: { dev: number; ino: number }, right: typeof left) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Resolve an existing, real artifacts directory without accepting root links. */
export async function resolveProfileArtifactsRoot(
  orgId: string,
  profileId: string
): Promise<string> {
  const profileDir = getProfileSoulDir(orgId, profileId);
  const artifactsDir = getProfileArtifactsDir(orgId, profileId);

  try {
    const [profileBefore, artifactsBefore] = await Promise.all([
      lstat(profileDir),
      lstat(artifactsDir),
    ]);
    if (
      profileBefore.isSymbolicLink() ||
      !profileBefore.isDirectory() ||
      artifactsBefore.isSymbolicLink() ||
      !artifactsBefore.isDirectory()
    ) {
      throw unsafeArtifactRootError();
    }

    const [resolvedProfileDir, resolvedArtifactsDir] = await Promise.all([
      realpath(profileDir),
      realpath(artifactsDir),
    ]);
    const [profileAfter, artifactsAfter] = await Promise.all([
      lstat(profileDir),
      lstat(artifactsDir),
    ]);
    const relativeRoot = path.relative(
      resolvedProfileDir,
      resolvedArtifactsDir
    );

    if (
      !(
        sameFile(profileBefore, profileAfter) &&
        sameFile(artifactsBefore, artifactsAfter)
      ) ||
      profileAfter.isSymbolicLink() ||
      artifactsAfter.isSymbolicLink() ||
      relativeRoot !== "artifacts" ||
      path.isAbsolute(relativeRoot)
    ) {
      throw unsafeArtifactRootError();
    }

    return resolvedArtifactsDir;
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new AtlasApiError("Artifact directory not found.", 404);
    }
    throw unsafeArtifactRootError();
  }
}

function unsafeArtifactRootError(): AtlasApiError {
  return new AtlasApiError(
    "Artifact directory must be a real directory inside the profile workspace.",
    400
  );
}
