export const sleep = async (duration: number) =>
  await new Promise((resolve) => setTimeout(resolve, duration));

// logged statements will have UTC timestamp prepended
const orignalConsoleLog = console.log;
console.log = function (...message) {
  const dateTime = new Date().toUTCString();
  orignalConsoleLog(dateTime, ...message);
};