import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const Cookies = (name: string) =>
  createParamDecorator((data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.cookies[name];
  })();
