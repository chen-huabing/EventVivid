import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TenantAuthGuard, TenantPrincipal } from '../tenant-auth/tenant-auth.guard';
import { CurrentTenantUser } from '../tenant-auth/tenant-user.decorator';
import { CreditPaymentsService } from './credit-payments.service';

@Controller('credit-purchases')
@UseGuards(TenantAuthGuard)
export class CreditPurchasesController {
 constructor(private readonly payments:CreditPaymentsService){}
 @Get('catalog') catalog(){return this.payments.catalog();}
 @Get() list(@CurrentTenantUser() user:TenantPrincipal){return this.payments.list(user);}
 @Post() create(@CurrentTenantUser() user:TenantPrincipal,@Body() body:unknown){return this.payments.create(user,body);}
 @Get(':id') get(@CurrentTenantUser() user:TenantPrincipal,@Param('id') id:string){return this.payments.owned(user,id);}
 @Post(':id/query') query(@CurrentTenantUser() user:TenantPrincipal,@Param('id') id:string){return this.payments.queryOwn(user,id);}
}

function payerCookie(req:FastifyRequest){return req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('ev_credit_payer='))?.slice('ev_credit_payer='.length);}

@Controller('credit-checkout')
export class CreditCheckoutController {
 constructor(private readonly payments:CreditPaymentsService){}
 @Get() get(@Headers('x-checkout-token') token:string,@Req() req:FastifyRequest){return this.payments.checkout(token||'',payerCookie(req));}
 @Post('query') query(@Headers('x-checkout-token') token:string,@Req() req:FastifyRequest){return this.payments.queryCheckout(token||'',payerCookie(req));}
 @Post('oauth') async oauth(@Headers('x-checkout-token') token:string){return {url:await this.payments.oauthStart(token||'')};}
 @Get('oauth/callback') async callback(@Query('code') code:string,@Query('state') state:string,@Res() reply:FastifyReply){
  const result=await this.payments.oauthCallback(code||'',state||'');
  reply.header('cache-control','no-store').header('referrer-policy','no-referrer').header('set-cookie',`ev_credit_payer=${result.cookie}; Path=/api/v1/credit-checkout; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`);
  return reply.redirect(302,result.url);
 }
 @Post('pay') pay(@Headers('x-checkout-token') token:string,@Req() req:FastifyRequest){return this.payments.pay(token||'',payerCookie(req)||'');}
 @Post('notify') @HttpCode(200) async notify(@Body() body:unknown,@Res() reply:FastifyReply){
  const acknowledgment=await this.payments.notify(body);
  return reply.type('text/plain; charset=utf-8').send(acknowledgment);
 }
}
