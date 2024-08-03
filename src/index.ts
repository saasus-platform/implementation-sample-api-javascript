import express, { Request, Response } from 'express'
import { AuthClient, AuthMiddleware, CallbackRouteFunction } from 'saasus-sdk'
import cors from 'cors'
import cookieParser from 'cookie-parser'

const PORT = 8080

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with'],
    methods: ['*'],
  })
)

app.use(['/userinfo', '/users'], AuthMiddleware)

app.get('/credentials', CallbackRouteFunction)

app.get('/refresh', async (request: Request, response: Response) => {
  const refreshToken = request.cookies.SaaSusRefreshToken
  if (typeof refreshToken !== 'string') {
    response.status(400).send('Refresh token not found')
    return
  }

  const client = new AuthClient()
  const credentials = (
    await client.credentialApi.getAuthCredentials(
      '',
      'refreshTokenAuth',
      refreshToken
    )
  ).data
  response.send(credentials)
})

app.get('/userinfo', (request: Request, response: Response) => {
  response.send(request.userInfo)
})

app.get('/users', async (request: Request, response: Response) => {
  const tenantId = request.userInfo?.tenants[0].id
  if (!tenantId) {
    response.status(400).send('TenantId not found')
    return
  }
  const client = new AuthClient()
  const users = (await client.tenantUserApi.getTenantUsers(tenantId)).data.users
  response.send(users)
})

app.listen(PORT, () => {
  console.log('Server running at PORT: ', PORT)
})
