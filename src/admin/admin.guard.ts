import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Auth for admin endpoints (e.g. backfill). Validates the `X-Admin-Token`
 * header against `ADMIN_BACKFILL_TOKEN`. If the env var is unset, the
 * guard FAILS CLOSED — admin endpoints are inaccessible by default in
 * environments that haven't explicitly configured them.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly expected: Buffer | null;

  constructor(config: ConfigService) {
    const token = config.get<string>('ADMIN_BACKFILL_TOKEN');
    this.expected = token ? Buffer.from(token, 'utf8') : null;
    if (!this.expected) {
      this.logger.warn(
        'ADMIN_BACKFILL_TOKEN not set — admin endpoints will reject all requests.',
      );
    }
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.expected) {
      throw new UnauthorizedException('Admin endpoints disabled (no token configured)');
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.header('x-admin-token');
    if (!provided) throw new UnauthorizedException('Missing X-Admin-Token header');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (
      providedBuf.length !== this.expected.length ||
      !timingSafeEqual(providedBuf, this.expected)
    ) {
      throw new UnauthorizedException('Invalid X-Admin-Token');
    }
    return true;
  }
}
