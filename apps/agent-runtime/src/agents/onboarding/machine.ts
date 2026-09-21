/**
 * The interview state machine is PURE and lives in agent-core
 * (`packages/agent-core/src/onboarding/machine.ts`, ≥ 30 unit tests with an
 * in-memory session) because this app has no test runner (FOLLOWUPS S1.6).
 * Re-exported here so the runtime reads naturally; nothing else is defined.
 */
export {
  stepMachine,
  promptFor,
  reviewButtons,
  capabilityProgress,
  businessNameOf,
  LANGUAGE_BUTTONS,
  type MachineSession,
  type MachineInbound,
  type MachineResult,
  type MachineAction,
  type MachinePatch,
  type OutboundMsg,
} from '@amclub/agent-core'
