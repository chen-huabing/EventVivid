import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { RegistrationService } from './registration.service';

@Controller()
export class RegistrationController {
  constructor(private readonly registrations: RegistrationService) {}
  @Post('public/events/:slug/registrations') register(
    @Param('slug') slug: string, @Body() body: unknown, @Headers('idempotency-key') key = '',
  ) { return this.registrations.register(slug, body, key); }
  @Post('orders/:orderId/payments/confirm') pay(@Param('orderId') orderId: string, @Headers('idempotency-key') key = '') {
    return this.registrations.confirmPayment(orderId, key);
  }
  @Get('public/tickets/:code') ticket(@Param('code') code: string) { return this.registrations.ticket(code); }
}
