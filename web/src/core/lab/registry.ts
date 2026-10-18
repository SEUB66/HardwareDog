/**
 * HARDWARE DOG / LAB COMMANDS
 *
 * Every action a companion message offers runs through here, by id. The
 * TV never calls a tool directly. A command already running is not
 * started again: a double click, a second window, a message repeated by
 * two rules all end up as one run. A command may say when it can run (a
 * guard): checked again at the moment of the click, not when the message
 * was written, so a RETRY offered a minute ago cannot start what no
 * longer makes sense. Nothing here retries on its own.
 */

export type LabCommand = (args?: Record<string, string>) => void | Promise<void>;
/** Why the command cannot run now, or null when it can. */
export type LabGuard = (args?: Record<string, string>) => string | null;

export class CommandRegistry {
  private commands = new Map<string, { run: LabCommand; guard: LabGuard | undefined }>();
  private running = new Set<string>();

  register(id: string, run: LabCommand, guard?: LabGuard): () => void {
    const entry = { run, guard };
    this.commands.set(id, entry);
    return () => {
      if (this.commands.get(id) === entry) this.commands.delete(id);
    };
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Why it cannot run now (unknown, running, its guard), or null. */
  blocked(id: string, args?: Record<string, string>): string | null {
    const c = this.commands.get(id);
    if (!c) return 'not available here';
    if (this.running.has(id)) return 'already running';
    return c.guard?.(args) ?? null;
  }

  /** Run a command. false: unknown, already running, or its guard said no (nothing started). */
  async run(id: string, args?: Record<string, string>): Promise<boolean> {
    const command = this.commands.get(id);
    if (!command || this.running.has(id) || command.guard?.(args)) return false;
    this.running.add(id);
    try {
      await command.run(args);
      return true;
    } finally {
      this.running.delete(id);
    }
  }
}
