import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantAuthGuard, TenantPrincipal } from './tenant-auth.guard';
import { TenantAuthService } from './tenant-auth.service';
import { CurrentTenantUser } from './tenant-user.decorator';

@Controller('auth')
export class TenantAuthController {
  constructor(private readonly auth: TenantAuthService) {}
  @Post('login') login(@Body() body: unknown) { return this.auth.login(body); }
  @Post('register') register(@Body() body: unknown) { return this.auth.register(body); }
  @Post('password-reset/request') requestPasswordReset(@Body() body: unknown) { return this.auth.requestPasswordReset(body); }
  @Post('password-reset/confirm') confirmPasswordReset(@Body() body: unknown) { return this.auth.confirmPasswordReset(body); }
  @Post('change-password') @UseGuards(TenantAuthGuard) changePassword(@CurrentTenantUser() user: TenantPrincipal, @Body() body: unknown) { return this.auth.changePassword(user.tenantId, user.id, body); }
  @Get('me') @UseGuards(TenantAuthGuard) me(@CurrentTenantUser() user: TenantPrincipal) { return user; }
  @Get('members') @UseGuards(TenantAuthGuard) members(@CurrentTenantUser() user: TenantPrincipal) { return this.auth.members(user.tenantId); }
  @Get('tenant') @UseGuards(TenantAuthGuard) tenant(@CurrentTenantUser() user: TenantPrincipal) { return this.auth.tenant(user.tenantId); }
  @Patch('tenant') @UseGuards(TenantAuthGuard) updateTenant(@CurrentTenantUser() user: TenantPrincipal, @Body() body: unknown) { return this.auth.updateTenant(user.tenantId, user.role, body); }
  @Post('members') @UseGuards(TenantAuthGuard) addMember(@CurrentTenantUser() user: TenantPrincipal, @Body() body: unknown) { return this.auth.addMember(user.tenantId, user.role, body); }
  @Patch('members/:memberId') @UseGuards(TenantAuthGuard) updateMember(@CurrentTenantUser() user: TenantPrincipal, @Param('memberId') memberId: string, @Body() body: unknown) { return this.auth.updateMember(user.tenantId, user.role, user.id, memberId, body); }
  @Delete('members/:memberId') @UseGuards(TenantAuthGuard) deleteMember(@CurrentTenantUser() user: TenantPrincipal, @Param('memberId') memberId: string) { return this.auth.deleteMember(user.tenantId, user.role, user.id, memberId); }
}
