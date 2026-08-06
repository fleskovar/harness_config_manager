import pc from 'picocolors';

let quiet = false;
let verbose = false;

export function configureLogger(options: { quiet?: boolean; verbose?: boolean }): void {
  quiet = options.quiet ?? false;
  verbose = options.verbose ?? false;
}

export const log = {
  info(message: string): void {
    if (!quiet) console.log(message);
  },
  step(message: string): void {
    if (!quiet) console.log(`${pc.cyan('•')} ${message}`);
  },
  success(message: string): void {
    if (!quiet) console.log(`${pc.green('✔')} ${message}`);
  },
  warn(message: string): void {
    console.warn(`${pc.yellow('!')} ${message}`);
  },
  error(message: string): void {
    console.error(`${pc.red('✖')} ${message}`);
  },
  debug(message: string): void {
    if (verbose && !quiet) console.log(pc.dim(`  ${message}`));
  },
  plain(message: string): void {
    console.log(message);
  },
};

export const color = pc;
