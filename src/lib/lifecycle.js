// src/lib/lifecycle.js
// Ciclo de vida del proceso (D7): graceful shutdown con timeout de drenado y
// handlers globales de errores. Con DI de `exit` para poder testear sin matar
// el proceso real.

'use strict';

// FR-SL-1/FR-SL-2: cierra el server (deja de aceptar conexiones, espera que
// completen las requests en vuelo), drena el pool y sale con exitCode.
// Si el drenado no completa en timeoutMs, fuerza exit(1). El timer va con
// .unref() para no mantener vivo el proceso si el server ya cerró.
// Devuelve una promesa que resuelve cuando se decide la salida (testable).
const shutdown = ({ server, pool, timeoutMs = 10000, exitCode = 0, exit = process.exit }) =>
  new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      exit(code);
      resolve();
    };

    timer = setTimeout(() => {
      console.error(`🕒 El drenado superó los ${timeoutMs}ms, forzando la salida`);
      finish(1);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    server.close(() => {
      const done = () => finish(exitCode);
      if (pool && typeof pool.end === 'function') {
        // El .catch evita unhandledRejection si pool.end falla durante el drenado:
        // igual se sale, pero con el código que corresponda.
        Promise.resolve(pool.end()).then(done, done);
      } else {
        done();
      }
    });
  });

// Construye los handlers individuales (exportados para testeo directo).
// Los tests de node:test no pueden emular los eventos 'unhandledRejection' /
// 'uncaughtException' con process.emit: el propio runner los captura y falla el
// test en curso. Por eso la política se testea llamando a estas funciones.
const createProcessHandlers = ({ server, pool, timeoutMs = 10000, exit = process.exit }) => ({
  // FR-SL-1: SIGTERM/SIGINT → drenado limpio + exit(0)
  handleSignal: (signal) => {
    console.log(`🛑 Recibido ${signal}, cerrando servidor...`);
    shutdown({ server, pool, timeoutMs, exitCode: 0, exit });
  },
  // FR-SL-3: promesa huérfana → log + drenado + exit(1). Estado indefinido:
  // no resumir, pero tampoco matar en caliente si hay requests en vuelo.
  handleRejection: (reason) => {
    console.error('❌ unhandledRejection detectada:', reason);
    shutdown({ server, pool, timeoutMs, exitCode: 1, exit });
  },
  // FR-SL-4: excepción síncrona → log + exit(1) inmediato, sin drenar.
  handleException: (err) => {
    console.error('❌ uncaughtException detectada:', err);
    exit(1);
  },
});

// Registra los handlers globales y devuelve cleanup() para removerlos.
const registerProcessHandlers = (options) => {
  const { handleSignal, handleRejection, handleException } = createProcessHandlers(options);

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
  process.on('unhandledRejection', handleRejection);
  process.on('uncaughtException', handleException);

  return () => {
    process.removeListener('SIGTERM', handleSignal);
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('unhandledRejection', handleRejection);
    process.removeListener('uncaughtException', handleException);
  };
};

module.exports = { shutdown, createProcessHandlers, registerProcessHandlers };