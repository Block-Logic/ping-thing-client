export const sleep = async (duration) =>
  await new Promise((resolve) => setTimeout(resolve, duration));