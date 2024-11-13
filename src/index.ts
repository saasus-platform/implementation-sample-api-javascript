import dotenv from 'dotenv'
dotenv.config()

import express, { Request, Response } from 'express'
import { AuthClient, AuthMiddleware, CallbackRouteFunction, PricingClient } from 'saasus-sdk'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { DeleteUserLog } from './models/DeleteUserLog'
import { CreateSaasUserParam, CreateTenantUserParam, CreateTenantUserRolesParam } from 'saasus-sdk/dist/generated/Auth'

const PORT = 80

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })
)

const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  entities: [DeleteUserLog],
  synchronize: true,
})

AppDataSource.initialize()
  .then(() => {
    console.log('Data Source has been initialized!')
  })
  .catch((err) => {
    console.error('Error during Data Source initialization', err)
  });

function belongingTenant(tenants: any[], tenantId: string): boolean {
  return tenants.some(tenant => tenant.id === tenantId);
}

app.use(['/userinfo', '/users', '/tenant_attributes', '/user_register', '/user_delete', '/delete_user_log', '/pricing_plan'], AuthMiddleware)

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
  console.log(request.userInfo)
  response.send(request.userInfo)
})

app.get('/users', async (request: Request, response: Response) => {
  const tenants = request.userInfo?.tenants
  if (!tenants) {
    response.status(400).send('No tenants found for the user')
    return
  }

  const tenantId = request.query.tenant_id
  if (!tenantId) {
    response.status(400).send('TenantId not found')
    return
  }

  if (typeof tenantId !== 'string') {
    return response.status(400).json({ detail: 'Invalid tenant ID' });
  }

  const client = new AuthClient()
  const users = (await client.tenantUserApi.getTenantUsers(tenantId)).data.users
  response.send(users)
})

app.get('/tenant_attributes', async(request: Request, response: Response) => {
  const tenants = request.userInfo?.tenants
  if (!tenants) {
    response.status(400).send('No tenants found for the user')
    return
  }

  const tenantId = request.query.tenant_id
  if (!tenantId) {
    response.status(400).send('TenantId not found')
    return
  }

  if (typeof tenantId !== 'string') {
    return response.status(400).json({ detail: 'Invalid tenant ID' });
  }

  try {
    const client = new AuthClient()
    const tenantAttributes = (await client.tenantAttributeApi.getTenantAttributes()).data

    const tenantInfo = (await client.tenantApi.getTenant(tenantId)).data

    const result: Record<string, any> = {};
    tenantAttributes.tenant_attributes.forEach((tenantAttribute) => {
      result[tenantAttribute.attribute_name] = {
        display_name: tenantAttribute.display_name,
        attribute_type: tenantAttribute.attribute_type,
        value: tenantInfo.attributes[tenantAttribute.attribute_name] || null,
      }
    })

    response.send(result)
  } catch (error) {
    console.error(error)
    response.status(500).json({ detail: error })
  }
  
})

app.get('/user_attributes', async(request: Request, response: Response) => {
  try {
    const client = new AuthClient()
    const userAttributes = (await client.userAttributeApi.getUserAttributes()).data
    
    response.json(userAttributes);
  } catch (error) {
    console.error(error)
    response.status(500).json({ detail: error })
  }
})

export interface UserRegisterRequest {
  email: string
  password: string
  tenantId: string
  userAttributeValues?: { [key: string]: any }
}

app.post('/user_register', async(request: Request, response: Response) => {
  const { email, password, tenantId, userAttributeValues }: UserRegisterRequest = request.body;
  if (!email || !password || !tenantId) {
      return response.status(400).send({ message: 'Missing required fields' });
  }

  const userInfo = request.userInfo
  if (userInfo === undefined) {
    return response.status(400).json({ detail: 'No user' })
  }

  if (!userInfo.tenants) {
    return response.status(400).json({ detail: 'No tenants found for the user' })
  }

  const isBelongingTenant = belongingTenant(userInfo.tenants, tenantId)
  if (!isBelongingTenant) {
    return response.status(400).json({ detail: 'Tenant that does not belong' })
  }

  try {
    // ユーザー属性情報を取得
    const client = new AuthClient()
    const userAttributesObj = (await client.userAttributeApi.getUserAttributes()).data

    let userAttributeValuesCopy = userAttributeValues || {}
    const userAttributes = userAttributesObj.user_attributes

    userAttributes.forEach((attribute) => {
      const attributeName = attribute.attribute_name
      const attributeType = attribute.attribute_type

      if (userAttributeValuesCopy[attributeName] && attributeType === 'number') {
        userAttributeValuesCopy[attributeName] = parseInt(userAttributeValuesCopy[attributeName], 10);
      }
    });

    // SaaSユーザー登録用パラメータを作成
    const createSaasUserParam: CreateSaasUserParam = {
      email,
      password
    }

    // SaaSユーザーを登録
    await client.saasUserApi.createSaasUser(createSaasUserParam)

    // テナントユーザー登録用のパラメータを作成
    const createTenantUserParam: CreateTenantUserParam = {
      email: email,
      attributes: userAttributeValuesCopy
    }
    // 作成したSaaSユーザーをテナントユーザーに追加
    const tenantUser = (await client.tenantUserApi.createTenantUser(tenantId, createTenantUserParam)).data

    // テナントに定義されたロール一覧を取得
    const rolesObj = (await client.roleApi.getRoles()).data

    // 初期値はadmin（SaaS管理者）とする
    const addRole = rolesObj.roles.some(role => role.role_name === 'user') ? 'user' : 'admin'

    // ロール設定用のパラメータを作成
    const createTenantUserRolesParam: CreateTenantUserRolesParam = {
      role_names: [addRole]
    }

    // 作成したテナントユーザーにロールを設定
    await client.tenantUserApi.createTenantUserRoles(tenantId, tenantUser.id, 3, createTenantUserRolesParam)

    response.json({ message: 'User registered successfully' });
  } catch (error) {
    console.error(error);
    response.status(500).json({ detail: error });
  }
})

export interface UserDeleteRequest {
  tenantId: string
  userId: string
}

app.delete('/user_delete', async (request: Request, response: Response) => {
  const { tenantId, userId }: UserDeleteRequest = request.body

  if (!tenantId || !userId) {
    return response.status(400).send({ message: 'Missing required fields' })
  }

  const userInfo = request.userInfo
  if (userInfo === undefined) {
    return response.status(400).json({ detail: 'No user' })
  }

  if (!userInfo.tenants) {
    return response.status(400).json({ detail: 'No tenants found for the user' })
  }

  const isBelongingTenant = belongingTenant(userInfo.tenants, tenantId)
  if (!isBelongingTenant) {
    return response.status(400).json({ detail: 'Tenant that does not belong' })
  }

  try {
      // SaaSusからユーザー情報を取得
      const client = new AuthClient()
      const deleteUser = (await client.tenantUserApi.getTenantUser(tenantId, userId)).data

      // テナントからユーザー情報を削除
      await client.tenantUserApi.deleteTenantUser(tenantId, userId)

      // ユーザー削除ログを設定
      const deleteUserLog = new DeleteUserLog(tenantId, userId, deleteUser.email)

      // データベースに登録
      const userDeleteLogRepository = AppDataSource.getRepository(DeleteUserLog)

      await userDeleteLogRepository.save(deleteUserLog);

      return response.json({ message: "User delete successfully" });
  } catch (error) {
      console.error(error);
      return response.status(500).json({ detail: error });
  }
})

export interface DeleteUserLogResponse {
  id: number
  tenant_id: string
  user_id: string
  email: string
  delete_at?: string | null
}

app.get('/delete_user_log', async (request: Request, response: Response) => {
  const tenantId = request.query.tenant_id

  if (tenantId === undefined) {
      return response.status(400).json({ detail: 'No tenant' })
  }

  if (typeof tenantId !== 'string') {
      return response.status(400).json({ detail: 'Invalid tenant ID' });
  }

  const userInfo = request.userInfo
  if (userInfo === undefined) {
    return response.status(400).json({ detail: 'No user' })
  }

  if (!userInfo.tenants) {
    return response.status(400).json({ detail: 'No tenants found for the user' })
  }

  const isBelongingTenant = belongingTenant(userInfo.tenants, tenantId)
  if (!isBelongingTenant) {
    return response.status(400).json({ detail: 'Tenant that does not belong' })
  }

  try {
      // ユーザー削除ログを取得
      const logs = await AppDataSource.getRepository(DeleteUserLog)
        .createQueryBuilder('log')
        .where('log.tenant_id = :tenantId', { tenantId })
        .getMany();

      const responseData: DeleteUserLogResponse[] = logs.map(log => ({
        id: log.id,
        tenant_id: log.tenant_id,
        user_id: log.user_id,
        email: log.email,
        delete_at: log.delete_at ? log.delete_at.toISOString() : null
      }))

      return response.json(responseData);
  } catch (error) {
      console.error(error);
      return response.status(500).json({ detail: error });
  }
})

app.get('/pricing_plan', async (request: Request, response: Response) => {
  const userInfo = request.userInfo
  if (userInfo === undefined) {
    return response.status(400).json({ detail: 'No user' })
  }

  if (!userInfo.tenants) {
    return response.status(400).json({ detail: 'No tenants found for the user' })
  }

  const planId = request.query.plan_id
  if (typeof planId !== 'string') {
      return response.status(400).json({ detail: 'Invalid tenant ID' });
  }

  if (!planId) {
      return response.status(400).json({ detail: 'No price plan found for the tenant' });
  }

  // ユーザーにテナントが存在しない場合はエラー
  if (!userInfo.tenants || userInfo.tenants.length === 0) {
      return response.status(400).json({ detail: 'No tenants found for the user' });
  }

  // クエリパラメータでテナントIDが渡されていない場合はエラー
  if (!planId) {
      return response.status(400).json({ detail: 'No price plan found for the tenant' });
  }

  try {
    const client = new PricingClient()
    const plan = (await client.pricingPlansApi.getPricingPlan(planId)).data
    return response.json(plan);
  } catch (error) {
      console.error(error);
      return response.status(500).json({ detail: error });
  }
})

app.listen(PORT, () => {
  console.log('Server running at PORT: ', PORT)
})
