export const sleep = async (dur) =>
  await new Promise((resolve) => setTimeout(resolve, dur));
