// Installed only in the ttnet helper. Cronet turns a failed CHECK into
// `brk #0` (SIGTRAP). The helper is the qsyy executable, so an uncaught
// trap makes macOS show "qsyy quit unexpectedly" even though the main
// process is fine and already respawns this one.
//
// Clear the inherited Mach exception ports for those traps, then _exit
// from the signal handler. _exit is async-signal-safe and does not produce
// a crash report. Re-arm because libsscronet may install its own handlers
// after the first request.
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include <dlfcn.h>
#include <mach/mach.h>

static void quiet_exit(int sig) {
  (void)sig;
  _exit(1);
}

static void arm(void) {
  struct sigaction action;
  action.sa_handler = quiet_exit;
  sigemptyset(&action.sa_mask);
  action.sa_flags = 0;
  sigaction(SIGTRAP, &action, NULL);
  sigaction(SIGILL, &action, NULL);
  sigaction(SIGABRT, &action, NULL);
  // MACH_PORT_NULL hands the exception back to the signal path. Leave
  // EXC_BAD_ACCESS alone so V8 can still handle its guard pages.
  task_set_exception_ports(
    mach_task_self(),
    EXC_MASK_BREAKPOINT | EXC_MASK_BAD_INSTRUCTION | EXC_MASK_CRASH,
    MACH_PORT_NULL,
    EXCEPTION_DEFAULT,
    0);
}

static void *rearm(void *unused) {
  (void)unused;
  for (;;) {
    sleep(1);
    arm();
  }
  return NULL;
}

__attribute__((constructor)) static void install(void) {
  Dl_info info;
  // Node dlopens, then dlcloses a library that did not self-register.
  // Pin the mapping first so the signal handler is still mapped afterwards.
  if (dladdr((void *)install, &info) && info.dli_fname) {
    dlopen(info.dli_fname, RTLD_NOW | RTLD_NOLOAD | RTLD_NODELETE);
  }
  if (getenv("QSYY_DEBUG") || getenv("SODA_DEBUG")) return;
  pthread_t thread;
  arm();
  if (pthread_create(&thread, NULL, rearm, NULL) == 0) pthread_detach(thread);
}
