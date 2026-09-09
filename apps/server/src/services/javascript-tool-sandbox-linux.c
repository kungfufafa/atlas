#ifdef __linux__

typedef unsigned long long atlas_u64;
extern int *__errno_location(void);
extern int chdir(const char *path);
extern int close(int file_descriptor);
extern int dprintf(int file_descriptor, const char *format, ...);
extern int execv(const char *path, char *const arguments[]);
extern char *getenv(const char *name);
extern int open(const char *path, int flags, ...);
extern int prctl(int option, ...);
extern char *strdup(const char *value);
extern char *strerror(int error_number);
extern long syscall(long number, ...);
extern int unsetenv(const char *name);
extern void _exit(int status);

#define ATLAS_ERRNO (*__errno_location())

#if defined(__x86_64__) || defined(__aarch64__)
#define ATLAS_SYS_CLOSE_RANGE 436
#define ATLAS_SYS_LANDLOCK_CREATE_RULESET 444
#define ATLAS_SYS_LANDLOCK_ADD_RULE 445
#define ATLAS_SYS_LANDLOCK_RESTRICT_SELF 446
#else
#error "Atlas Landlock launcher supports Linux x86_64 and aarch64"
#endif

#define ATLAS_O_CLOEXEC 02000000
#define ATLAS_O_PATH 010000000
#define ATLAS_PR_SET_NO_NEW_PRIVS 38

#define ATLAS_LANDLOCK_CREATE_RULESET_VERSION 1
#define ATLAS_LANDLOCK_RULE_PATH_BENEATH 1

#define ATLAS_ACCESS_FS_EXECUTE (1ULL << 0)
#define ATLAS_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define ATLAS_ACCESS_FS_READ_FILE (1ULL << 2)
#define ATLAS_ACCESS_FS_READ_DIR (1ULL << 3)
#define ATLAS_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define ATLAS_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define ATLAS_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#define ATLAS_ACCESS_FS_MAKE_DIR (1ULL << 7)
#define ATLAS_ACCESS_FS_MAKE_REG (1ULL << 8)
#define ATLAS_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#define ATLAS_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#define ATLAS_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define ATLAS_ACCESS_FS_MAKE_SYM (1ULL << 12)
#define ATLAS_ACCESS_FS_REFER (1ULL << 13)
#define ATLAS_ACCESS_FS_TRUNCATE (1ULL << 14)
#define ATLAS_ACCESS_FS_IOCTL_DEV (1ULL << 15)

#define ATLAS_READ_FILE_ACCESS ATLAS_ACCESS_FS_READ_FILE
#define ATLAS_EXECUTABLE_ACCESS \
  (ATLAS_ACCESS_FS_EXECUTE | ATLAS_ACCESS_FS_READ_FILE)
#define ATLAS_READ_DIRECTORY_ACCESS \
  (ATLAS_ACCESS_FS_READ_FILE | ATLAS_ACCESS_FS_READ_DIR)
#define ATLAS_WORKSPACE_ACCESS \
  (ATLAS_ACCESS_FS_EXECUTE | ATLAS_ACCESS_FS_WRITE_FILE | \
   ATLAS_ACCESS_FS_READ_FILE | ATLAS_ACCESS_FS_READ_DIR | \
   ATLAS_ACCESS_FS_REMOVE_DIR | ATLAS_ACCESS_FS_REMOVE_FILE | \
   ATLAS_ACCESS_FS_MAKE_DIR | ATLAS_ACCESS_FS_MAKE_REG | \
   ATLAS_ACCESS_FS_MAKE_SOCK | ATLAS_ACCESS_FS_MAKE_FIFO | \
   ATLAS_ACCESS_FS_MAKE_SYM | ATLAS_ACCESS_FS_REFER | \
   ATLAS_ACCESS_FS_TRUNCATE)

struct atlas_landlock_ruleset_attr {
  atlas_u64 handled_access_fs;
};

struct atlas_landlock_path_beneath_attr {
  atlas_u64 allowed_access;
  int parent_fd;
  unsigned int reserved;
};

static int atlas_add_path_rule(
  int ruleset_fd,
  const char *path,
  atlas_u64 allowed_access,
  int required
) {
  int path_fd = open(path, ATLAS_O_PATH | ATLAS_O_CLOEXEC);
  if (path_fd < 0) {
    if (!required && ATLAS_ERRNO == 2) {
      return 0;
    }
    dprintf(
      2,
      "Landlock could not open allowed path %s: %s\n",
      path,
      strerror(ATLAS_ERRNO)
    );
    return -1;
  }

  struct atlas_landlock_path_beneath_attr rule = {
    .allowed_access = allowed_access,
    .parent_fd = path_fd,
    .reserved = 0,
  };
  long result = syscall(
    ATLAS_SYS_LANDLOCK_ADD_RULE,
    ruleset_fd,
    ATLAS_LANDLOCK_RULE_PATH_BENEATH,
    &rule,
    0
  );
  int saved_errno = ATLAS_ERRNO;
  close(path_fd);

  if (result < 0) {
    dprintf(
      2,
      "Landlock could not allow path %s: %s\n",
      path,
      strerror(saved_errno)
    );
    return -1;
  }
  return 0;
}

static char *atlas_required_environment(const char *name) {
  char *value = getenv(name);
  if (value == 0 || value[0] == '\0') {
    dprintf(2, "Landlock launcher is missing %s.\n", name);
    return 0;
  }
  return strdup(value);
}

static void atlas_close_inherited_descriptors(void) {
  long result = syscall(ATLAS_SYS_CLOSE_RANGE, 3, ~0U, 0);
  if (result >= 0) {
    return;
  }

  int file_descriptor;
  for (file_descriptor = 3; file_descriptor < 4096; file_descriptor += 1) {
    close(file_descriptor);
  }
}

int atlas_landlock_and_exec(void) {
  const char *internal_names[] = {
    "ATLAS_CUSTOM_TOOL_SANDBOX_BUN",
    "ATLAS_CUSTOM_TOOL_SANDBOX_RUNNER",
    "ATLAS_CUSTOM_TOOL_SANDBOX_RUNNER_DIR",
    "ATLAS_CUSTOM_TOOL_SANDBOX_MODE",
    "ATLAS_CUSTOM_TOOL_SANDBOX_MODULE",
    "ATLAS_CUSTOM_TOOL_SANDBOX_MODULE_DIR",
    "ATLAS_CUSTOM_TOOL_SANDBOX_MODULE_ROOT",
    "ATLAS_CUSTOM_TOOL_SANDBOX_WORKSPACE",
    "ATLAS_CUSTOM_TOOL_SANDBOX_TEMP",
  };
  char *bun_path = atlas_required_environment(internal_names[0]);
  char *runner_path = atlas_required_environment(internal_names[1]);
  char *runner_directory = atlas_required_environment(internal_names[2]);
  char *mode = atlas_required_environment(internal_names[3]);
  char *module_path = atlas_required_environment(internal_names[4]);
  char *module_directory = atlas_required_environment(internal_names[5]);
  char *module_root_path = getenv(internal_names[6]);
  char *workspace_path = getenv(internal_names[7]);
  char *temp_path = atlas_required_environment(internal_names[8]);

  if (
    bun_path == 0 || runner_path == 0 || runner_directory == 0 || mode == 0 ||
    module_path == 0 || module_directory == 0 || temp_path == 0
  ) {
    return 1;
  }

  char *workspace_copy =
    workspace_path != 0 && workspace_path[0] != '\0'
      ? strdup(workspace_path)
      : 0;
  char *module_root_copy =
    module_root_path != 0 && module_root_path[0] != '\0'
      ? strdup(module_root_path)
      : 0;

  unsigned int name_index;
  for (name_index = 0; name_index < 9; name_index += 1) {
    unsetenv(internal_names[name_index]);
  }

  if (chdir(module_directory) < 0) {
    dprintf(
      2,
      "Landlock could not enter the custom-tool module directory: %s\n",
      strerror(ATLAS_ERRNO)
    );
    return 1;
  }

  long abi = syscall(
    ATLAS_SYS_LANDLOCK_CREATE_RULESET,
    0,
    0,
    ATLAS_LANDLOCK_CREATE_RULESET_VERSION
  );
  if (abi < 3) {
    dprintf(
      2,
      "Custom JavaScript tools require Landlock ABI 3 or newer "
      "(Linux kernel 6.2+); detected ABI %ld. "
      "Execution was blocked.\n",
      abi
    );
    return 1;
  }

  atlas_u64 handled_access =
    ATLAS_ACCESS_FS_EXECUTE | ATLAS_ACCESS_FS_WRITE_FILE |
    ATLAS_ACCESS_FS_READ_FILE | ATLAS_ACCESS_FS_READ_DIR |
    ATLAS_ACCESS_FS_REMOVE_DIR | ATLAS_ACCESS_FS_REMOVE_FILE |
    ATLAS_ACCESS_FS_MAKE_CHAR | ATLAS_ACCESS_FS_MAKE_DIR |
    ATLAS_ACCESS_FS_MAKE_REG | ATLAS_ACCESS_FS_MAKE_SOCK |
    ATLAS_ACCESS_FS_MAKE_FIFO | ATLAS_ACCESS_FS_MAKE_BLOCK |
    ATLAS_ACCESS_FS_MAKE_SYM | ATLAS_ACCESS_FS_REFER |
    ATLAS_ACCESS_FS_TRUNCATE;
  if (abi >= 5) {
    handled_access |= ATLAS_ACCESS_FS_IOCTL_DEV;
  }

  struct atlas_landlock_ruleset_attr ruleset = {
    .handled_access_fs = handled_access,
  };
  int ruleset_fd = (int) syscall(
    ATLAS_SYS_LANDLOCK_CREATE_RULESET,
    &ruleset,
    sizeof(ruleset),
    0
  );
  if (ruleset_fd < 0) {
    dprintf(
      2,
      "Landlock could not create a filesystem ruleset: %s\n",
      strerror(ATLAS_ERRNO)
    );
    return 1;
  }

  const char *runtime_directories[] = {
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/lib64",
    "/usr/share/zoneinfo",
    "/etc/ssl",
    "/etc/pki",
    "/etc/ca-certificates",
    "/proc/self",
  };
  const char *runtime_files[] = {
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/localtime",
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
  };
  const char *runtime_executables[] = {
#if defined(__x86_64__)
    "/lib64/ld-linux-x86-64.so.2",
    "/lib/ld-linux-x86-64.so.2",
    "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
    "/lib/ld-musl-x86_64.so.1",
#elif defined(__aarch64__)
    "/lib/ld-linux-aarch64.so.1",
    "/lib64/ld-linux-aarch64.so.1",
    "/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1",
    "/lib/ld-musl-aarch64.so.1",
#endif
  };

  int failed = 0;
  unsigned int path_index;
  for (
    path_index = 0;
    path_index < sizeof(runtime_directories) / sizeof(runtime_directories[0]);
    path_index += 1
  ) {
    if (
      atlas_add_path_rule(
        ruleset_fd,
        runtime_directories[path_index],
        ATLAS_READ_DIRECTORY_ACCESS,
        0
      ) < 0
    ) {
      failed = 1;
    }
  }
  for (
    path_index = 0;
    path_index < sizeof(runtime_files) / sizeof(runtime_files[0]);
    path_index += 1
  ) {
    if (
      atlas_add_path_rule(
        ruleset_fd,
        runtime_files[path_index],
        ATLAS_READ_FILE_ACCESS,
        0
      ) < 0
    ) {
      failed = 1;
    }
  }
  // A dynamically linked Bun binary needs EXECUTE permission on its exact ELF
  // interpreter after Landlock is active. Keep this narrower than granting
  // executable access to the complete system library directories.
  for (
    path_index = 0;
    path_index < sizeof(runtime_executables) / sizeof(runtime_executables[0]);
    path_index += 1
  ) {
    if (
      atlas_add_path_rule(
        ruleset_fd,
        runtime_executables[path_index],
        ATLAS_EXECUTABLE_ACCESS,
        0
      ) < 0
    ) {
      failed = 1;
    }
  }

  if (
    atlas_add_path_rule(
      ruleset_fd,
      bun_path,
      ATLAS_EXECUTABLE_ACCESS,
      1
    ) < 0 ||
    atlas_add_path_rule(
      ruleset_fd,
      runner_path,
      ATLAS_READ_FILE_ACCESS,
      1
    ) < 0 ||
    atlas_add_path_rule(
      ruleset_fd,
      runner_directory,
      ATLAS_ACCESS_FS_READ_DIR,
      1
    ) < 0 ||
    atlas_add_path_rule(
      ruleset_fd,
      module_path,
      ATLAS_READ_FILE_ACCESS,
      1
    ) < 0 ||
    atlas_add_path_rule(
      ruleset_fd,
      module_directory,
      ATLAS_ACCESS_FS_READ_DIR,
      1
    ) < 0 ||
    atlas_add_path_rule(
      ruleset_fd,
      temp_path,
      ATLAS_WORKSPACE_ACCESS,
      1
    ) < 0
  ) {
    failed = 1;
  }
  if (
    module_root_copy != 0 &&
    atlas_add_path_rule(
      ruleset_fd,
      module_root_copy,
      ATLAS_READ_DIRECTORY_ACCESS,
      1
    ) < 0
  ) {
    failed = 1;
  }
  if (
    workspace_copy != 0 &&
    atlas_add_path_rule(
      ruleset_fd,
      workspace_copy,
      ATLAS_WORKSPACE_ACCESS,
      1
    ) < 0
  ) {
    failed = 1;
  }

  if (failed) {
    close(ruleset_fd);
    return 1;
  }

  if (prctl(ATLAS_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    dprintf(
      2,
      "Landlock could not set no_new_privs: %s\n",
      strerror(ATLAS_ERRNO)
    );
    close(ruleset_fd);
    return 1;
  }
  if (
    syscall(ATLAS_SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0) < 0
  ) {
    dprintf(
      2,
      "Landlock could not restrict the custom-tool process: %s\n",
      strerror(ATLAS_ERRNO)
    );
    close(ruleset_fd);
    return 1;
  }
  close(ruleset_fd);

  char *arguments[] = {
    bun_path,
    // The module cwd can contain authored bunfig preloads and .env files.
    // /dev/null is already an explicit runtime grant in this Linux policy.
    "--config=/dev/null",
    "--env-file=/dev/null",
    "--no-install",
    "--no-addons",
    runner_path,
    mode,
    module_path,
    0,
  };

  atlas_close_inherited_descriptors();
  execv(bun_path, arguments);
  int exec_error = ATLAS_ERRNO;
  dprintf(
    2,
    "Landlock could not start the custom-tool runner: %s\n",
    strerror(exec_error)
  );
  // Descriptors owned by Bun's event loop and FFI runtime are already closed.
  // Returning to JavaScript here would leave the launcher in a corrupted state.
  _exit(126);
  return 126;
}

#else

int atlas_landlock_and_exec(void) {
  return 1;
}

#endif
