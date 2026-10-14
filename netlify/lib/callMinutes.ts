// Retell permits 60 seconds to two hours. Three minutes is a demo-only policy.
export const CALL_MIN_SECONDS = 60
export const CALL_MAX_SECONDS = 7200
export const DEMO_CALL_MAX_SECONDS = 180
export const getCallMaxSeconds = (demoMode: boolean) => demoMode ? DEMO_CALL_MAX_SECONDS : CALL_MAX_SECONDS
