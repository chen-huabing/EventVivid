import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentContext, RequestContext } from '../shared/request-context';
import { TenantAuthGuard } from '../tenant-auth/tenant-auth.guard';
import { CheckinService } from './checkin.service';

@Controller('checkins')
@UseGuards(TenantAuthGuard)
export class CheckinController {
  constructor(private readonly checkins: CheckinService) {}
  @Get('my-events') myEvents(@CurrentContext() context: RequestContext) { return this.checkins.myEvents(context); }
  @Get('points') missingEventId() { throw new BadRequestException('请提供活动 ID'); }
  @Get('points/:eventId') points(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) {
    return this.checkins.points(context, eventId);
  }
  @Post('points/:eventId') createPoint(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.checkins.createPoint(context, eventId, body);
  }
  @Patch('points/:pointId') updatePoint(@CurrentContext() context: RequestContext, @Param('pointId') pointId: string, @Body() body: unknown) {
    return this.checkins.updatePoint(context, pointId, body);
  }
  @Put('points/:pointId/staff') updatePointStaff(@CurrentContext() context: RequestContext, @Param('pointId') pointId: string, @Body() body: unknown) {
    return this.checkins.updatePointStaff(context, pointId, body);
  }
  @Get('staff/:eventId') staff(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) {
    return this.checkins.staff(context, eventId);
  }
  @Get('verify') verify(@CurrentContext() context: RequestContext, @Query('code') code: string) {
    return this.checkins.verify(context, code);
  }
  @Post('scan') scan(
    @CurrentContext() context: RequestContext, @Body() body: unknown, @Headers('idempotency-key') key = '',
  ) { return this.checkins.scan(context, body, key); }
  @Get('stats/:eventId') stats(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) {
    return this.checkins.stats(context, eventId);
  }
}
