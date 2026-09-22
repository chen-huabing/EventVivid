import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentContext, RequestContext } from '../shared/request-context';
import { TenantAuthGuard } from '../tenant-auth/tenant-auth.guard';
import { EventsService } from './events.service';

@Controller('events')
@UseGuards(TenantAuthGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}
  @Get() list(@CurrentContext() context: RequestContext) { return this.events.list(context); }
  @Post() create(@CurrentContext() context: RequestContext, @Body() body: unknown) { return this.events.create(context, body); }
  @Get(':eventId') get(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) { return this.events.get(context, eventId); }
  @Patch(':eventId') update(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string, @Body() body: unknown) { return this.events.update(context, eventId, body); }
  @Patch(':eventId/registration-style') updateRegistrationStyle(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string, @Body() body: unknown) { return this.events.updateRegistrationStyle(context, eventId, body); }
  @Get(':eventId/registration-form') registrationForm(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) { return this.events.registrationForm(context, eventId); }
  @Patch(':eventId/registration-form') updateRegistrationForm(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string, @Body() body: unknown) { return this.events.updateRegistrationForm(context, eventId, body); }
  @Post(':eventId/preview-token') previewToken(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) { return this.events.createPreviewToken(context, eventId); }
  @Get(':eventId/ticket-types') ticketTypes(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) { return this.events.ticketTypes(context, eventId); }
  @Get(':eventId/registrations') registrations(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) { return this.events.registrations(context, eventId); }
  @Get(':eventId/orders') orders(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) { return this.events.orders(context, eventId); }
  @Get(':eventId/issued-tickets') issuedTickets(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) { return this.events.issuedTickets(context, eventId); }
  @Post(':eventId/ticket-types') addTicket(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string, @Body() body: unknown) {
    return this.events.addTicketType(context, eventId, body);
  }
  @Patch(':eventId/ticket-types/:ticketTypeId') updateTicket(
    @CurrentContext() context: RequestContext, @Param('eventId') eventId: string,
    @Param('ticketTypeId') ticketTypeId: string, @Body() body: unknown,
  ) { return this.events.updateTicketType(context, eventId, ticketTypeId, body); }
  @Delete(':eventId/ticket-types/:ticketTypeId') deleteTicket(
    @CurrentContext() context: RequestContext, @Param('eventId') eventId: string,
    @Param('ticketTypeId') ticketTypeId: string,
  ) { return this.events.deleteTicketType(context, eventId, ticketTypeId); }
  @Post(':eventId/publish') publish(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) {
    return this.events.publish(context, eventId);
  }
  @Post(':eventId/unpublish') unpublish(@CurrentContext() context: RequestContext, @Param('eventId') eventId: string) {
    return this.events.unpublish(context, eventId);
  }
}

@Controller('public/events')
export class PublicEventsController {
  constructor(private readonly events: EventsService) {}
  @Get(':slug') get(@Param('slug') slug: string) { return this.events.publicBySlug(slug); }
  @Get(':slug/preview') preview(@Param('slug') slug: string, @Query('token') token = '') { return this.events.previewBySlug(slug, token); }
}
