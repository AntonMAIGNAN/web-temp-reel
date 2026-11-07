import { type AxiosInstance } from "axios";
import { type StatusCodes } from "./types.ts";

export const post = async <T = unknown>(
  axiosInstance: AxiosInstance,
  url: string,
  path: string,
  body?: unknown,
): Promise<{ status: StatusCodes; data: T }> => {
  const { status, data } = await axiosInstance.post<T>(`${url}${path}`, body, {
    validateStatus: () => true,
  });

  return { status: status as StatusCodes, data };
};
