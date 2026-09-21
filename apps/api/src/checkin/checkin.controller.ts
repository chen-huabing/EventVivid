import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { CurrentContext, RequestContext } from '../shared/request-context';
import { CheckinService } from './checkin.service';

@Controller('checkins')
export class CheckinController {
  constructor(private readonly checkins: CheckinService) {}
  @Get('points/:eventId') points(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) {
    return this.checkins.points(context, eventId);
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
