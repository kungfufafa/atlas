// Reuse the existing Landlock ABI definitions, rule installation and descriptor
// cleanup primitives. Both launchers must ship together in the server build.
#include "javascript-tool-sandbox-linux.c"

#ifdef __linux__
extern long strtol(const char *value, char **end, int base);
extern int snprintf(char *buffer, unsigned long size, const char *format, ...);

#define ATLAS_MAX_RESTRICTED_ARGS 64
#define ATLAS_MAX_RESTRICTED_ROOTS 96

static char *atlas_indexed_environment(const char *prefix, int index) {
  char key[96];
  snprintf(key, sizeof(key), "%s%d", prefix, index);
  char *value = getenv(key);
  char *copy = value == 0 ? 0 : strdup(value);
  unsetenv(key);
  return copy;
}

int atlas_restricted_process_exec(void) {
  char *argc_value = atlas_required_environment("ATLAS_RESTRICTED_ARGC");
  char *rootc_value = atlas_required_environment("ATLAS_RESTRICTED_RULEC");
  unsetenv("ATLAS_RESTRICTED_ARGC");
  unsetenv("ATLAS_RESTRICTED_RULEC");
  if (argc_value == 0 || rootc_value == 0) return 1;
  long argc = strtol(argc_value, 0, 10);
  long rootc = strtol(rootc_value, 0, 10);
  if (argc < 1 || argc > ATLAS_MAX_RESTRICTED_ARGS || rootc < 1 || rootc > ATLAS_MAX_RESTRICTED_ROOTS) return 1;
  char *arguments[ATLAS_MAX_RESTRICTED_ARGS + 1] = {0};
  char *roots[ATLAS_MAX_RESTRICTED_ROOTS] = {0};
  char *modes[ATLAS_MAX_RESTRICTED_ROOTS] = {0};
  int i;
  for (i = 0; i < argc; i++) {
    arguments[i] = atlas_indexed_environment("ATLAS_RESTRICTED_ARG_", i);
    if (arguments[i] == 0) return 1;
  }
  for (i = 0; i < rootc; i++) {
    roots[i] = atlas_indexed_environment("ATLAS_RESTRICTED_ROOT_", i);
    modes[i] = atlas_indexed_environment("ATLAS_RESTRICTED_MODE_", i);
    if (roots[i] == 0 || modes[i] == 0) return 1;
  }

  long abi = syscall(ATLAS_SYS_LANDLOCK_CREATE_RULESET, 0, 0, ATLAS_LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) {
    dprintf(2, "Python/Bash require Linux Landlock ABI 3 or newer; detected %ld. Execution was blocked.\n", abi);
    return 1;
  }
  atlas_u64 handled = ATLAS_WORKSPACE_ACCESS | ATLAS_ACCESS_FS_MAKE_CHAR | ATLAS_ACCESS_FS_MAKE_BLOCK;
  if (abi >= 5) handled |= ATLAS_ACCESS_FS_IOCTL_DEV;
  struct atlas_landlock_ruleset_attr ruleset = { .handled_access_fs = handled };
  int fd = (int) syscall(ATLAS_SYS_LANDLOCK_CREATE_RULESET, &ruleset, sizeof(ruleset), 0);
  if (fd < 0) {
    dprintf(2, "Landlock ruleset failed: %s\n", strerror(ATLAS_ERRNO));
    return 1;
  }
  for (i = 0; i < rootc; i++) {
    // Runtime directories are executable/read-only, regular files read-only.
    // Device writes are limited separately to /dev/null below.
    atlas_u64 allowed = modes[i][0] == 'w' ? ATLAS_WORKSPACE_ACCESS :
      modes[i][0] == 'r' ? ATLAS_READ_DIRECTORY_ACCESS | ATLAS_ACCESS_FS_EXECUTE :
      modes[i][0] == 'e' ? ATLAS_EXECUTABLE_ACCESS : ATLAS_READ_FILE_ACCESS;
    if (atlas_add_path_rule(fd, roots[i], allowed, 1) < 0) { close(fd); return 1; }
  }
  if (atlas_add_path_rule(fd, "/dev/null", ATLAS_ACCESS_FS_READ_FILE | ATLAS_ACCESS_FS_WRITE_FILE, 1) < 0) { close(fd); return 1; }
  // glibc discovers the main thread stack through this process's maps file.
  // Bun/JSC aborts before executing JavaScript without those stack bounds.
  // Bind only this launch PID's maps inode before exec: never expose a proc
  // directory, host/tenant process maps, environ, or descriptor entries. Future
  // descendants inherit this fixed inode rule, not access to their own maps.
  if (atlas_add_path_rule(fd, "/proc/self/maps", ATLAS_READ_FILE_ACCESS, 1) < 0) { close(fd); return 1; }
  if (prctl(ATLAS_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 || syscall(ATLAS_SYS_LANDLOCK_RESTRICT_SELF, fd, 0) < 0) {
    dprintf(2, "Landlock restriction failed: %s\n", strerror(ATLAS_ERRNO));
    close(fd);
    return 1;
  }
  close(fd);
  // ABI 3 implies a kernel newer than close_range. If a host security policy
  // blocks it, fail closed rather than leave a high-numbered inherited fd open.
  if (syscall(ATLAS_SYS_CLOSE_RANGE, 3, ~0U, 0) < 0) {
    dprintf(2, "Landlock could not close inherited descriptors: %s\n", strerror(ATLAS_ERRNO));
    _exit(126);
  }
  execv(arguments[0], arguments);
  dprintf(2, "Landlock could not start Python/Bash: %s\n", strerror(ATLAS_ERRNO));
  _exit(126);
  return 126;
}
#else
int atlas_restricted_process_exec(void) { return 1; }
#endif
