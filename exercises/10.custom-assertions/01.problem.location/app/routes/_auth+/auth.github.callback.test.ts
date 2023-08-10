import { generateTOTP } from '@epic-web/totp'
import { faker } from '@faker-js/faker'
import { rest } from 'msw'
import * as setCookieParser from 'set-cookie-parser'
import { createUser, insertNewUser } from 'tests/db-utils.ts'
import { mockGithubProfile, primaryGitHubEmail } from 'tests/mocks/github.ts'
import { server } from 'tests/mocks/index.ts'
import { consoleError } from 'tests/setup/setup-test-env.ts'
import { expect, test } from 'vitest'
import { getSessionExpirationDate, sessionKey } from '~/utils/auth.server.ts'
import { prisma } from '~/utils/db.server.ts'
import { invariant } from '~/utils/misc.tsx'
import { sessionStorage } from '~/utils/session.server.ts'
import { twoFAVerificationType } from '../settings+/profile.two-factor.tsx'
import { ROUTE_PATH, loader } from './auth.github.callback.ts'

const BASE_URL = 'https://www.epicstack.dev'

// 🐨 add expect.extend call here
// 🐨   create a toHaveRedirect "matcher" function here that accepts the response and an optional redirectTo
// 🐨   return a failing result if:
//      - The redirecTo was supplied and it does not match the location
//      - The response.status is not between 300 and 400
//      - The redirectTo was not supplied, but there's no location
//        (in this case they don't care where it's redirecting, just that it is)
// 💯   As extra credit, handle this.isNot in the message
// 💯   Use this.utils.printExpected/this.utils.printReceived

// 🦺 here's the template for making the types work:
// interface CustomMatchers<R = unknown> {
// 	// 🦉 note that the first argument to your matcher is not represented in this type!
// 	toBeLoggedIn(userName: string): R
// }

// declare module 'vitest' {
// 	interface Assertion<T = any> extends CustomMatchers<T> {}
// 	interface AsymmetricMatchersContaining extends CustomMatchers {}
// }

test('a new user goes to onboarding', async () => {
	const request = await setupRequest()
	const response = await loader({ request, params: {}, context: {} })
	// 🐨 replace this with your custom matcher:
	// expect(response).toHaveRedirect('/onboarding/github')
	assertRedirect(response, '/onboarding/github')
})

test('when auth fails, send the user to login with a toast', async () => {
	server.use(
		rest.post('https://github.com/login/oauth/access_token', async () => {
			return new Response('error', { status: 400 })
		}),
	)
	const request = await setupRequest()
	const response = await loader({ request, params: {}, context: {} }).catch(
		e => e,
	)
	invariant(response instanceof Response, 'response should be a Response')
	// 🐨 replace this with your custom matcher:
	// expect(response).toHaveRedirect('/login')
	assertRedirect(response, '/login')
	assertToastSent(response)
	expect(consoleError).toHaveBeenCalledTimes(1)
	consoleError.mockClear()
})

test('when a user is logged in, it creates the connection', async () => {
	const session = await setupUser()
	const request = await setupRequest(session.id)
	const response = await loader({ request, params: {}, context: {} })
	// 🐨 replace this with your custom matcher:
	// expect(response).toHaveRedirect('/settings/profile/connections')
	assertRedirect(response, '/settings/profile/connections')
	assertToastSent(response)
	const connection = await prisma.gitHubConnection.findFirst({
		select: { id: true },
		where: {
			userId: session.userId,
			providerId: mockGithubProfile.id.toString(),
		},
	})
	expect(
		connection,
		'the connection was not created in the database',
	).toBeTruthy()
})

test(`when a user is logged in and has already connected, it doesn't do anything and just redirects the user back to the connections page`, async () => {
	const session = await setupUser()
	await prisma.gitHubConnection.create({
		data: {
			userId: session.userId,
			providerId: mockGithubProfile.id.toString(),
		},
	})
	const request = await setupRequest(session.id)
	const response = await loader({ request, params: {}, context: {} })
	// 🐨 replace this with your custom matcher:
	// expect(response).toHaveRedirect('/settings/profile/connections')
	assertRedirect(response, '/settings/profile/connections')
	assertToastSent(response)
})

test('when a user exists with the same email, create connection and make session', async () => {
	const email = primaryGitHubEmail.email.toLowerCase()
	const { userId } = await setupUser({ ...createUser(), email })
	const request = await setupRequest()
	const response = await loader({ request, params: {}, context: {} })

	// 🐨 replace this with your custom matcher:
	// expect(response).toHaveRedirect('/')
	assertRedirect(response, '/')

	assertToastSent(response)

	const connection = await prisma.gitHubConnection.findFirst({
		select: { id: true },
		where: {
			userId,
			providerId: mockGithubProfile.id.toString(),
		},
	})
	expect(
		connection,
		'the connection was not created in the database',
	).toBeTruthy()

	await assertSessionMade(response, userId)
})

test('gives an error if the account is already connected to another user', async () => {
	const newUser = await insertNewUser()
	await prisma.user.update({
		where: { id: newUser.id },
		data: {
			gitHubConnections: {
				create: { providerId: mockGithubProfile.id.toString() },
			},
		},
	})
	const session = await setupUser()
	const request = await setupRequest(session.id)
	const response = await loader({ request, params: {}, context: {} })
	// 🐨 replace this with your custom matcher:
	// expect(response).toHaveRedirect('/settings/profile/connections')
	assertRedirect(response, '/settings/profile/connections')
	assertToastSent(response)
})

test('if a user is not logged in, but the connection exists, make a session', async () => {
	const { userId } = await setupUser()
	await prisma.gitHubConnection.create({
		data: {
			providerId: mockGithubProfile.id.toString(),
			userId,
		},
	})
	const request = await setupRequest()
	const response = await loader({ request, params: {}, context: {} })
	// 🐨 replace this with your custom matcher:
	// expect(response).toHaveRedirect('/')
	assertRedirect(response, '/')
	await assertSessionMade(response, userId)
})

test('if a user is not logged in, but the connection exists and they have enabled 2FA, send them to verify their 2FA and do not make a session', async () => {
	const { userId } = await setupUser()
	await prisma.gitHubConnection.create({
		data: {
			providerId: mockGithubProfile.id.toString(),
			userId,
		},
	})
	const { otp: _otp, ...config } = generateTOTP()
	await prisma.verification.create({
		data: {
			type: twoFAVerificationType,
			target: userId,
			...config,
		},
	})
	const request = await setupRequest()
	const response = await loader({ request, params: {}, context: {} })
	const searchParams = new URLSearchParams({
		type: twoFAVerificationType,
		target: userId,
		redirectTo: '/',
		remember: 'on',
	})
	searchParams.sort()
	assertRedirect(response, `/verify?${searchParams}`)
})

async function setupRequest(sessionId?: string) {
	const url = new URL(ROUTE_PATH, BASE_URL)
	const state = faker.string.uuid()
	const code = faker.string.uuid()
	url.searchParams.set('state', state)
	url.searchParams.set('code', code)
	const cookieSession = await sessionStorage.getSession()
	cookieSession.set('oauth2:state', state)
	if (sessionId) cookieSession.set(sessionKey, sessionId)
	const setCookieHeader = await sessionStorage.commitSession(cookieSession)
	const request = new Request(url.toString(), {
		method: 'GET',
		headers: { cookie: convertSetCookieToCookie(setCookieHeader) },
	})
	return request
}

async function setupUser(userData = createUser()) {
	const newUser = await insertNewUser(userData)
	const session = await prisma.session.create({
		data: {
			expirationDate: getSessionExpirationDate(),
			user: { connect: newUser },
		},
		select: { id: true, userId: true },
	})

	return session
}

function assertToastSent(response: Response) {
	const setCookie = response.headers.get('set-cookie')
	invariant(setCookie, 'set-cookie header should be set')
	const parsedCookie = setCookieParser.splitCookiesString(setCookie)
	expect(parsedCookie).toEqual(
		expect.arrayContaining([expect.stringContaining('en_toast')]),
	)
}

async function assertSessionMade(response: Response, userId: string) {
	const setCookie = response.headers.get('set-cookie')
	invariant(setCookie, 'set-cookie header should be set')
	const parsedCookie = setCookieParser.splitCookiesString(setCookie)
	expect(parsedCookie).toEqual(
		expect.arrayContaining([expect.stringContaining('en_session')]),
	)
	const session = await prisma.session.findFirst({
		select: { id: true },
		where: { userId },
	})
	expect(session).toBeTruthy()
}

// 💣 you can remove this now:
function assertRedirect(response: Response, redirectTo: string) {
	expect(response.status).toBeGreaterThanOrEqual(300)
	expect(response.status).toBeLessThan(400)
	expect(response.headers.get('location')).toBe(redirectTo)
}

function convertSetCookieToCookie(setCookie: string) {
	const parsedCookie = setCookieParser.parseString(setCookie)
	return new URLSearchParams({
		[parsedCookie.name]: parsedCookie.value,
	}).toString()
}