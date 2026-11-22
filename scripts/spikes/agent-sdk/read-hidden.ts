/**
 * Read one line from the terminal without echoing it: how a key reaches this
 * run. A key is never an argument, an environment variable typed on a command
 * line, or a file in this folder.
 */
import { stdin, stdout } from 'node:process';

export function readHidden(prompt: string): Promise<string> {
    if (!stdin.isTTY) return Promise.reject(new Error('Run this in a terminal: a key is read from a hidden prompt.'));
    return new Promise((resolve, reject) => {
        stdout.write(prompt);
        let value = '';
        const done = (err?: Error) => {
            stdin.off('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            stdout.write('\n');
            if (err) reject(err);
            else resolve(value.trim());
        };
        const onData = (chunk: string) => {
            for (const c of chunk) {
                if (c === '\r' || c === '\n') return done();
                if (c === '\u0003') return done(new Error('Cancelled.'));
                if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
                else value += c;
            }
        };
        stdin.setRawMode(true);
        stdin.setEncoding('utf8');
        stdin.resume();
        stdin.on('data', onData);
    });
}
