import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { DomainError } from '../shared/domain-error.filter';

export interface HqPrincipal { id: string; username: string; displayName: string; role: string; }

@Injectable()
export class HqAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; hqUser?: HqPrincipal }>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new DomainError('总部后台登录已失效', HttpStatus.UNAUTHORIZED);
    try {
      const payload = jwt.verify(authorization.slice(7), process.env.JWT_SECRET ?? '') as jwt.JwtPayload;
      request.hqUser = { id: String(payload.sub), username: String(payload.username), displayName: String(payload.displayName), role: String(payload.role) };
      return true;
    } catch {
      throw new DomainError('总部后台登录已失效', HttpStatus.UNAUTHORIZED);
    }
  }
}
