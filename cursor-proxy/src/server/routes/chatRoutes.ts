// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the costgate project.

import { Request, Response, Router } from 'express';
import { handleChatCompletion } from '../handlers/chatHandler.js';

/**
 * 把 async handler 的 rejection 接住，别让它变成 unhandledRejection。
 *
 * Express 4 只认同步异常——async 函数里抛的错既不会进 error middleware，
 * 也不会被 router 捕获，Node 22 默认 `--unhandled-rejections=throw`
 * 于是**整个进程退出**。
 *
 * 2026-11-08 实测踩到：一个上游的 API Key 解不开（换了机器 / 只拷了
 * data/proxy.db 没带 .encryption-key / Docker 未挂载密钥文件），
 * crypto 在 findProviderConfig 里抛 `Unsupported state or unable to
 * authenticate data`，整个 cursor-proxy 就这么没了——日志里只有一段堆栈，
 * 表现为「服务莫名其妙退出」，跟「某个上游的 key 坏了」看不出关系。
 *
 * 现在：带 code/status 的错误按原样回给客户端（message 是我们自己写的可读
 * 说明，不含内部堆栈），其余一律 500 INTERNAL_ERROR。进程不再退出。
 */
export function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    Promise.resolve(fn(req, res)).catch((e: any) => {
      const code = typeof e?.code === 'string' ? e.code : 'INTERNAL_ERROR';
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 500;
      console.error(`[ChatRoutes] ${code}: ${e?.message || e}`);
      if (res.headersSent) {
        // 已经在往外写（流式）：只能收尾，不能再改状态码。
        try {
          res.end();
        } catch {
          /* 客户端已断开 */
        }
        return;
      }
      res.status(status).json({
        success: false,
        error: typeof e?.message === 'string' && e.message ? e.message : 'Internal server error',
        code,
      });
    });
  };
}

export const router = Router();
router.post('/chat/completions', asyncHandler(handleChatCompletion));
