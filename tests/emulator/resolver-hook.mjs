import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

/**
 * Dos ajustes para poder ejecutar los handlers de api/ tal cual estan:
 *
 * 1. Sus imports terminan en ".js" (convencion de Node ESM que Vercel resuelve al
 *    compilar); aqui apuntamos al ".ts" correspondiente.
 * 2. Con AUTH_MOCK=1 sustituimos firebase-admin/auth por un doble local, porque el
 *    emulador de Auth no esta levantado y el handler valida el token.
 */
export async function resolve(specifier, context, nextResolve) {
  if (process.env.AUTH_MOCK === '1' && specifier === 'firebase-admin/auth') {
    return {
      shortCircuit: true,
      url: pathToFileURL(resolvePath(process.cwd(), 'tests/emulator/mock-auth.mjs')).href
    };
  }

  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      const candidato = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(candidato))) {
        return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
      }
    } catch {
      // sigue con la resolucion normal
    }
  }

  return nextResolve(specifier, context);
}
