'use strict';

// SPDX-License-Identifier: MIT
// Fase 10.1 — Circuit breaker ligero (cockatiel/opossum-style sin dependencia externa)
// Estados: CLOSED → OPEN → HALF_OPEN → CLOSED
// Uso: const breaker = new CircuitBreaker(fn, { failureThreshold: 5, timeout: 10000 })

const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class CircuitBreaker {
  /**
   * @param {Function} action - async function to protect
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=5] - fallos antes de abrir
   * @param {number} [opts.successThreshold=2] - éxitos en HALF_OPEN para cerrar
   * @param {number} [opts.timeout=10000] - tiempo en OPEN antes de HALF_OPEN (ms)
   * @param {number} [opts.volumeThreshold=3] - mínimo llamadas antes de evaluar ratio
   */
  constructor(action, opts = {}) {
    if (typeof action !== 'function') throw new Error('CircuitBreaker action must be function');
    this.action = action;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 2;
    this.timeout = opts.timeout ?? 10_000;
    this.volumeThreshold = opts.volumeThreshold ?? 3;

    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = 0;
    this.totalCount = 0;
  }

  getState() {
    return this.state;
  }

  async fire(...args) {
    // Si OPEN, verifica si toca probar HALF_OPEN
    if (this.state === STATE.OPEN) {
      if (Date.now() < this.nextAttempt) {
        const err = new Error('Circuit breaker is OPEN');
        err.code = 'CIRCUIT_OPEN';
        err.statusCode = 503;
        throw err;
      }
      this.state = STATE.HALF_OPEN;
      this.successes = 0;
    }

    try {
      const result = await this.action(...args);
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.totalCount += 1;
    if (this.state === STATE.HALF_OPEN) {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.reset();
      }
    } else if (this.state === STATE.CLOSED) {
      // éxito resetea contador de fallos después de ventana
      this.failures = 0;
    }
  }

  onFailure() {
    this.totalCount += 1;
    this.failures += 1;
    if (this.state === STATE.HALF_OPEN) {
      this.trip();
    } else if (
      this.state === STATE.CLOSED &&
      this.failures >= this.failureThreshold &&
      this.totalCount >= this.volumeThreshold
    ) {
      this.trip();
    }
  }

  trip() {
    this.state = STATE.OPEN;
    this.nextAttempt = Date.now() + this.timeout;
    this.failures = 0;
    this.successes = 0;
  }

  reset() {
    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.totalCount = 0;
    this.nextAttempt = 0;
  }

  // Métricas para observabilidad
  getStats() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      nextAttempt: this.nextAttempt,
      totalCount: this.totalCount,
    };
  }
}

module.exports = { CircuitBreaker, STATE };
