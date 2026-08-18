/**
 * @deprecated Compatibility facade for legacy imports.
 *
 * The fixed stage runner was removed from the authority path in Phase 1.
 * New code must import useTranslationCoordinator directly. This facade keeps
 * older UI/plugin imports source-compatible while delegating all behavior to
 * the native-session Coordinator.
 */
export {
  TRANSLATION_AGENT_PROFILE,
  TRANSLATION_COORDINATOR_PROFILE,
  TRANSLATION_METADATA_KEY,
  buildTranslationCoordinatorGoal,
  useTranslationCoordinator as useTranslationRunner,
} from './useTranslationCoordinator';
export type {
  ApplyTranslationOverrideRequest,
  CreateTranslationProjectRequest,
  TranslationCoordinatorHost as TranslationRunnerHost,
  TranslationProjectSession,
  UseTranslationCoordinator as UseTranslationRunner,
} from './useTranslationCoordinator';
