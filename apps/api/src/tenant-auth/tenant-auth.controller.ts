import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { TenantAuthGuard, TenantPrincipal } from './tenant-auth.guard';
import { TenantAuthService } from './tenant-auth.service';
import { CurrentTenantUser } from './tenant-user.decorator';

@Controller('auth')
export class TenantAuthController {
  constructor(private readonly auth: TenantAuthService) {}
  @Post('login') login(@Body() body: unknown) { return this.auth.login(body); }
  @Get('me') @UseGuards(TenantAuthGuard) me(@CurrentTenantUser() user: TenantPrincipal) { return user; }
}
