import { Body, Controller, Get, Ip, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { HqAuthGuard, HqPrincipal } from './hq-auth.guard';
import { CurrentHqUser } from './hq-user.decorator';
import { HqService } from './hq.service';

@Controller('hq/auth')
export class HqAuthController {
  constructor(private readonly hq: HqService) {}
  @Post('login') login(@Body() body: unknown, @Ip() ip: string) { return this.hq.login(body, ip); }
  @Get('me') @UseGuards(HqAuthGuard) me(@CurrentHqUser() user: HqPrincipal) { return user; }
}

@Controller('hq')
@UseGuards(HqAuthGuard)
export class HqController {
  constructor(private readonly hq: HqService) {}
  @Get('dashboard') dashboard() { return this.hq.dashboard(); }
  @Get('tenants') tenants() { return this.hq.listTenants(); }
  @Post('tenants') createTenant(@CurrentHqUser() user: HqPrincipal, @Body() body: unknown, @Ip() ip: string) { return this.hq.createTenant(user, body, ip); }
  @Patch('tenants/:tenantId') updateTenant(@CurrentHqUser() user: HqPrincipal, @Param('tenantId') tenantId: string, @Body() body: unknown, @Ip() ip: string) { return this.hq.updateTenant(user, tenantId, body, ip); }
  @Patch('tenants/:tenantId/status') updateTenantStatus(@CurrentHqUser() user: HqPrincipal, @Param('tenantId') tenantId: string, @Body() body: unknown, @Ip() ip: string) { return this.hq.updateTenantStatus(user, tenantId, body, ip); }
  @Get('tenants/:tenantId/admins') tenantAdmins(@Param('tenantId') tenantId: string) { return this.hq.tenantAdmins(tenantId); }
  @Patch('tenants/:tenantId/admins/:adminId') updateTenantAdmin(@CurrentHqUser() user: HqPrincipal, @Param('tenantId') tenantId: string, @Param('adminId') adminId: string, @Body() body: unknown, @Ip() ip: string) { return this.hq.updateTenantAdmin(user, tenantId, adminId, body, ip); }
  @Get('plans') plans() { return this.hq.plans(); }
  @Get('audit-logs') auditLogs() { return this.hq.auditLogs(); }
}
