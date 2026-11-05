export function isRanzoBotBuild(appName, environment = process.env) {
  return environment.RANZOBOT_VARIANT === "1" || appName?.toLowerCase() === "ranzobot";
}
