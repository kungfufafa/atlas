/** Static trusted reader. No profile code, module search, or executable input. */
export const SELECTED_ARTIFACT_CAPTURE_SCRIPT = String.raw`
import base64, hashlib, json, os, stat, sys

LIMIT = 25 * 1024 * 1024
class Rejected(Exception):
    pass
def require(condition, code):
    if not condition:
        raise Rejected(code)
def identity(value):
    return {"device": str(value.st_dev), "inode": str(value.st_ino)}
def metadata(value):
    return dict(identity(value), sizeBytes=value.st_size, mtimeNs=str(value.st_mtime_ns),
                ctimeNs=str(value.st_ctime_ns), linkCount=value.st_nlink)
def same_identity(left, right):
    return identity(left) == identity(right)
def visible_path(value):
    require(isinstance(value, str) and len(value) <= 4096, "INVALID_PATH")
    parts = value.split("/")
    require(len(parts) >= 2 and parts[0] == "artifacts" and len(parts) <= 64, "INVALID_PATH")
    require(all(part and not part.startswith(".") and "\\" not in part
                and all(ord(c) >= 32 and ord(c) != 127 for c in part) for part in parts), "INVALID_PATH")
    require(not parts[-1].lower().endswith(".atlas-meta.json"), "INVALID_PATH")
    return parts
def main(request):
    require(sys.platform in ("darwin", "linux"), "UNSUPPORTED_HOST")
    require(os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd
            and os.stat in os.supports_follow_symlinks
            and all(hasattr(os, key) for key in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_CLOEXEC")), "UNSUPPORTED_HOST")
    root = request.get("root")
    require(isinstance(root, str) and root.startswith("/") and root != "/"
            and len(root) <= 4096 and all(ord(c) >= 32 and ord(c) != 127 for c in root), "INVALID_ROOT")
    root_parts = root[1:].split("/")
    require(len(root_parts) <= 64 and all(part not in ("", ".", "..") for part in root_parts), "INVALID_ROOT")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptors, links, observed_directories = [], [], []
    def open_directory(parent, name):
        fd = os.open(name, directory_flags, dir_fd=parent)
        descriptors.append(fd)
        value = os.fstat(fd)
        require(stat.S_ISDIR(value.st_mode), "NOT_DIRECTORY")
        links.append((parent, name, fd, value))
        return fd, value
    def verify():
        for parent, name, fd, before in links:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISDIR(current.st_mode) and same_identity(current, before)
                    and same_identity(os.fstat(fd), before), "DIRECTORY_REPLACED")
        for fd, before in observed_directories:
            require(metadata(os.fstat(fd)) == metadata(before), "DIRECTORY_CHANGED")
    try:
        parent = os.open("/", directory_flags)
        descriptors.append(parent)
        for name in root_parts:
            parent, root_stat = open_directory(parent, name)
        root_fd = parent
        # Test fixtures may pause here; the production script has no external barrier input.
        # CAPTURE_ROOT_OPENED
        if request.get("operation") == "anchor":
            verify()
            return {"rootIdentity": identity(root_stat)}
        require(request.get("operation") == "capture", "INVALID_OPERATION")
        require(request.get("expectedRoot") == identity(root_stat), "ROOT_REPLACED")
        observed_directories.append((root_fd, root_stat))
        parts = visible_path(request.get("sourcePath"))
        for name in parts[:-1]:
            parent, value = open_directory(parent, name)
            observed_directories.append((parent, value))
            # CAPTURE_PARENT_OPENED
        verify()
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | getattr(os, "O_NOCTTY", 0)
        file_fd = os.open(parts[-1], flags, dir_fd=parent)
        descriptors.append(file_fd)
        before = os.fstat(file_fd)
        require(stat.S_ISREG(before.st_mode), "NOT_REGULAR_FILE")
        require(before.st_nlink == 1, "HARDLINK_REJECTED")
        require(0 <= before.st_size <= LIMIT, "TOO_LARGE")
        # CAPTURE_FILE_OPENED
        chunks, size = [], 0
        while True:
            chunk = os.read(file_fd, min(65536, LIMIT + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            require(size <= LIMIT, "TOO_LARGE")
            # CAPTURE_CHUNK_READ
        after = os.fstat(file_fd)
        require(stat.S_ISREG(after.st_mode) and after.st_nlink == 1
                and metadata(after) == metadata(before) and size == before.st_size, "FILE_CHANGED")
        named = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        require(stat.S_ISREG(named.st_mode) and metadata(named) == metadata(after), "FILE_REPLACED")
        verify()
        captured = b"".join(chunks)
        return {"bytesBase64": base64.b64encode(captured).decode("ascii"), "evidence": {
            "kind": "selected_workspace_capture", "version": 1, "sourcePath": request["sourcePath"],
            "rootIdentity": identity(root_stat), "file": metadata(after),
            "sha256": hashlib.sha256(captured).hexdigest(), "sizeBytes": len(captured),
            "reader": "posix_dirfd_nofollow", "observedMetadataStable": True}}
    finally:
        for fd in reversed(descriptors):
            os.close(fd)

try:
    raw = sys.stdin.buffer.read(16385)
    require(len(raw) <= 16384, "REQUEST_TOO_LARGE")
    response = main(json.loads(raw))
    sys.stdout.write(json.dumps(response, separators=(",", ":")))
except Rejected as error:
    sys.stdout.write(json.dumps({"error": {"code": str(error)}}))
    sys.exit(2)
except Exception:
    sys.stdout.write(json.dumps({"error": {"code": "CAPTURE_IO_REJECTED"}}))
    sys.exit(2)
`;
