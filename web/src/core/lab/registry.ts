/**
 * HARDWARE DOG / LAB COMMANDS
 *
 * Every action a companion message offers runs through here, by id. The
 * TV never calls a tool directly. A command already running is not
 * started again: a double click, a second window, a message repeated by
 * two rules all end up as one run.
 */

export type LabCommand = (args?: Record<string, string>) => void | Promise<void>;

export class CommandRegistry {
  private commands = new Map<string, LabCommand>();
  private running = new Set<string>();

  register(id: string, run: LabCommand): () => void {
    this.commands.set(id, run);
    return () => {
      if (this.commands.get(id) === run) this.commands.delete(id);
    };
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Run a command. false: unknown, or already running (nothing started). */
  async run(id: string, args?: Record<string, string>): Promise<boolean> {
    const command = this.commands.get(id);
    if (!command || this.running.has(id)) return false;
    this.running.add(id);
    try {
      await command(args);
      return true;
    } finally {
      this.running.delete(id);
    }
  }
}
